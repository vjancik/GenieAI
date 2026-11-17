/**
 * Markdown-aware text splitter for Discord's 2000-character message limit.
 *
 * Works in three stages:
 * 1. {@link tokenize} — cuts the text into lines and classifies each one.
 * 2. {@link parseBlocks} — a small state machine groups lines into blocks
 *    (plain line, table, fenced code block). The grammar has no nesting, so no
 *    stack is needed.
 * 3. {@link extractPage} — greedily packs blocks into one page, applying a
 *    split strategy per block kind.
 *
 * Guarantees for every page:
 * - its content never exceeds the limit, synthetic markup included;
 * - it consumes at least one character of source text;
 * - its code fences are balanced, as long as the limit leaves room for the
 *   fence markup (see {@link rawSplit} for the degenerate case).
 *
 * Pages are a pure function of (text, offset, limit, open code block label), so
 * paginating up-front and paginating page by page always agree.
 */

/** Options for {@link splitMarkdown}. */
export interface SplitMarkdownOptions {
    /**
     * When true, the whole text is paginated from offset 0 and `pageCount` is
     * included in the result. Used by the caller to compute the footer string
     * before sending page 1.
     */
    pageCount?: true;
    /**
     * When the previous page ended inside a fenced code block, pass its syntax
     * label (e.g. `"typescript"`), or an empty string for an unlabelled block.
     * The page then starts with a ` ```{label} ` line that re-opens the block.
     * That line counts toward the limit but does not advance the text offset.
     *
     * Must be `null` or omitted when the previous page did not end in a code
     * block. Ignored when `pageCount` is true, where the state is derived by
     * paginating from the start.
     */
    continuationCodeBlock?: string | null;
    /**
     * Override the character limit for page 1 only (e.g. when the first page
     * carries a header/footer overhead that subsequent pages do not). Only
     * applied when `pageCount` is true.
     */
    firstPageLimit?: number;
}

/** Result of a {@link splitMarkdown} call. */
export interface SplitMarkdownResult {
    /**
     * The content to display for this page (without footer — caller appends it).
     * The line break at a page boundary is consumed but not emitted, so content
     * never ends with the newline that separated it from the next page.
     */
    content: string;
    /** Character offset in the original text where this page ends (= start of next page). */
    newOffset: number;
    /**
     * Total page count for the full text at the given limit.
     * Only present when `options.pageCount === true` was passed.
     */
    pageCount?: number;
    /**
     * True when the page boundary falls inside a fenced code block. The next page
     * must be requested with the matching label
     * (see {@link SplitMarkdownOptions.continuationCodeBlock}).
     */
    endedInCodeBlock: boolean;
    /**
     * The syntax label of the code block open at the page boundary (e.g. `"typescript"`),
     * or an empty string for an unlabelled block. `null` when `endedInCodeBlock` is false.
     */
    codeBlockType: string | null;
}

type Page = Omit<SplitMarkdownResult, "pageCount">;

/** Default Discord message character limit. */
const DEFAULT_LIMIT = 2000;

const FENCE = "```";

/** Synthetic closing fence appended to a page that ends inside a code block. */
const FENCE_CLOSE = `\n${FENCE}`;

/** Appended where a line had to be cut mid-way, to signal that it continues. */
const ELLIPSIS = "…";

/**
 * - `fence`: starts with ``` and holds no second ``` — opens or closes a block.
 * - `inlineFence`: starts with ``` and closes on the same line (```code```).
 *   Plain text outside a block; inside one it still closes it, as Discord ends
 *   a block at the first ``` it meets.
 * - `tableRow`: starts with `|`.
 * - `blank`: empty or whitespace only. Parsed like `text`.
 */
type LineKind = "fence" | "inlineFence" | "tableRow" | "blank" | "text";

/** One source line. Offsets are absolute positions in the full text. */
interface Line {
    start: number;
    /** End of the line's content, excluding its line terminator. */
    end: number;
    /** Start of the following line (= `end` plus the terminator length). */
    next: number;
    kind: LineKind;
    /** Text after the opening ``` of a `fence` line; empty for other kinds. */
    label: string;
}

interface TextBlock {
    kind: "text";
    line: Line;
}

interface TableBlock {
    kind: "table";
    rows: Line[];
}

interface CodeBlock {
    kind: "code";
    label: string;
    /** `null` when the block was opened on a previous page. */
    opener: Line | null;
    body: Line[];
    /**
     * `null` when the text ends before the block is closed, or when the block runs
     * past the tokenizer's horizon. In the latter case its final line does not fit
     * on the page, which keeps it from being mistaken for the end of the text.
     */
    closer: Line | null;
}

type Block = TextBlock | TableBlock | CodeBlock;

/** Classifies one line's content. Leading indentation of any depth is ignored. */
function classify(content: string): Pick<Line, "kind" | "label"> {
    const trimmed = content.trimStart();
    if (trimmed === "") return { kind: "blank", label: "" };
    if (!trimmed.startsWith(FENCE)) {
        return { kind: trimmed.startsWith("|") ? "tableRow" : "text", label: "" };
    }
    const rest = trimmed.slice(FENCE.length);
    return rest.includes(FENCE) ? { kind: "inlineFence", label: "" } : { kind: "fence", label: rest.trimEnd() };
}

/**
 * Splits `text` from `offset` into classified lines. Both `\n` and `\r\n` end a line.
 *
 * Stops after the first line that ends more than `horizon` characters past `offset`:
 * neither that line nor any later one can be placed whole on a page of that size, so
 * the cost of extracting a page does not grow with the length of the remaining text.
 */
function tokenize(text: string, offset: number, horizon: number): Line[] {
    const lines: Line[] = [];
    let start = offset;
    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const next = newline === -1 ? text.length : newline + 1;
        let end = newline === -1 ? text.length : newline;
        if (newline > start && text[newline - 1] === "\r") end--;
        lines.push({ start, end, next, ...classify(text.slice(start, end)) });
        if (end - offset > horizon) break;
        start = next;
    }
    return lines;
}

/**
 * Groups lines into blocks with a three-state machine (prose, in table, in code).
 *
 * @param openCodeLabel - Label of a code block already open at the first line,
 *                        or `null` to start in prose.
 */
function parseBlocks(lines: Line[], openCodeLabel: string | null): Block[] {
    const blocks: Block[] = [];
    let code: CodeBlock | null = null;
    let table: TableBlock | null = null;

    if (openCodeLabel !== null && lines.length > 0) {
        code = { kind: "code", label: openCodeLabel, opener: null, body: [], closer: null };
        blocks.push(code);
    }

    for (const line of lines) {
        if (code) {
            if (line.kind === "fence" || line.kind === "inlineFence") {
                code.closer = line;
                code = null;
            } else {
                code.body.push(line);
            }
            continue;
        }
        if (line.kind === "tableRow") {
            if (!table) {
                table = { kind: "table", rows: [] };
                blocks.push(table);
            }
            table.rows.push(line);
            continue;
        }
        table = null;
        if (line.kind === "fence") {
            code = { kind: "code", label: line.label, opener: line, body: [], closer: null };
            blocks.push(code);
        } else {
            blocks.push({ kind: "text", line });
        }
    }
    return blocks;
}

/** Returns the start of the first non-blank line at or after the line start `from`, or the end of the text. */
function skipBlankLines(text: string, from: number): number {
    let start = from;
    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;
        if (text.slice(start, end).trim() !== "") break;
        start = newline === -1 ? text.length : newline + 1;
    }
    return start;
}

/** Moves a cut position one step back when it would separate a surrogate pair. */
function avoidSurrogateSplit(text: string, cut: number, floor: number): number {
    const previous = text.charCodeAt(cut - 1);
    const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
    return isHighSurrogate && cut - 1 > floor ? cut - 1 : cut;
}

/**
 * Last-resort page made of the first line of the page alone, with no synthetic
 * fences: the whole line when it fits, otherwise as much of it as fits followed
 * by an ellipsis.
 *
 * Used for a line longer than a page, and when the limit is too small to hold
 * a code block's fence markup next to any content. In the latter case the page
 * is not fence-balanced, but the reported state still tracks the source.
 *
 * @param labelIfWhole - Code block left open after the whole line was emitted.
 * @param labelIfCut - Code block left open after the line was cut mid-way.
 */
function rawSplit(
    text: string,
    offset: number,
    limit: number,
    line: Line,
    labelIfWhole: string | null,
    labelIfCut: string | null,
): Page {
    if (line.end - offset <= limit) {
        return {
            content: text.slice(offset, line.end),
            newOffset: line.next,
            endedInCodeBlock: labelIfWhole !== null,
            codeBlockType: labelIfWhole,
        };
    }
    // A limit of 1 has no room for the ellipsis next to a character of content.
    const marker = limit > ELLIPSIS.length ? ELLIPSIS : "";
    const cut = avoidSurrogateSplit(text, offset + limit - marker.length, offset);
    return {
        content: text.slice(offset, cut) + marker,
        newOffset: cut,
        endedInCodeBlock: labelIfCut !== null,
        codeBlockType: labelIfCut,
    };
}

/**
 * Extracts one page of at most `limit` characters starting at `offset`.
 *
 * Split strategy per block:
 * - plain line: break before it; a line longer than a page is cut with an ellipsis.
 * - table: kept whole, moving to the next page if needed; a table longer than
 *   a page is split between rows.
 * - code block: split between body lines, closing the block on this page and
 *   re-opening it on the next. A body line longer than a page is cut inside
 *   the fences.
 *
 * @param openCodeLabel - Label of the code block the previous page ended in, or `null`.
 */
function extractPage(text: string, offset: number, limit: number, openCodeLabel: string | null): Page {
    const lines = tokenize(text, offset, limit);
    const blocks = parseBlocks(lines, openCodeLabel);
    // Re-opens the code block carried over from the previous page.
    const header = openCodeLabel !== null && lines.length > 0 ? `${FENCE}${openCodeLabel}\n` : "";

    /** Whether the page can end right after `line` with `reserve` characters of synthetic markup to spare. */
    const fits = (line: Line, reserve = 0) => header.length + (line.end - offset) + reserve <= limit;
    const fitsWithClose = (line: Line) => fits(line, FENCE_CLOSE.length);

    /** Ends the page after `last`, closing the code block `openLabel` if one is open there. */
    const pageEndingAt = (last: Line, openLabel: string | null): Page => {
        const content = header + text.slice(offset, last.end);
        if (openLabel !== null) {
            return {
                content: content + FENCE_CLOSE,
                newOffset: last.next,
                endedInCodeBlock: true,
                codeBlockType: openLabel,
            };
        }
        // Discord trims messages, so whitespace around a prose boundary is dropped:
        // the blank lines that follow are consumed here instead of opening the next
        // page, where they could add up to a message with nothing to display.
        return {
            content: content.trimEnd(),
            newOffset: skipBlankLines(text, last.next),
            endedInCodeBlock: false,
            codeBlockType: null,
        };
    };

    // Last line placed on the page so far; `null` while the page is empty.
    let last: Line | null = null;
    // False while the page holds nothing but blank lines. Such a page must not be
    // ended early, so it is treated like an empty one.
    let hasContent = false;

    for (const block of blocks) {
        if (block.kind === "text") {
            if (fits(block.line)) {
                last = block.line;
                hasContent ||= block.line.kind !== "blank";
                continue;
            }
            return last && hasContent
                ? pageEndingAt(last, null)
                : rawSplit(text, offset, limit, block.line, null, null);
        }

        if (block.kind === "table") {
            const finalRow = block.rows.at(-1);
            if (finalRow && fits(finalRow)) {
                last = finalRow;
                hasContent = true;
                continue;
            }
            // Move the whole table to the next page, where it gets a full page of room.
            if (last && hasContent) return pageEndingAt(last, null);
            // The table starts this page and is longer than it: split between rows.
            const lastFittingRow = block.rows.findLast((row) => fits(row));
            if (lastFittingRow) return pageEndingAt(lastFittingRow, null);
            const firstRow = block.rows[0];
            if (firstRow) return rawSplit(text, offset, limit, firstRow, null, null);
            continue;
        }

        const { label, opener, body, closer } = block;
        if (closer && fits(closer)) {
            last = closer;
            hasContent = true;
            continue;
        }
        // The text ends inside the block: close it on its final page.
        const finalLine = body.at(-1) ?? opener;
        if (!closer && finalLine && fitsWithClose(finalLine)) return pageEndingAt(finalLine, label);

        // Split between body lines. At least one body line stays on this page, and
        // one goes to the next page alongside the real closing fence, so neither
        // page holds an empty code block.
        const splitCandidates = closer ? body.slice(0, -1) : body;
        const lastFittingBodyLine = splitCandidates.findLast(fitsWithClose);
        if (lastFittingBodyLine) return pageEndingAt(lastFittingBodyLine, label);

        // No body line fits behind what is already on the page: move the block.
        if (last && hasContent) return pageEndingAt(last, null);

        // From here on the block starts the page.
        const firstBodyLine = body[0];
        if (firstBodyLine && fitsWithClose(firstBodyLine)) {
            // Only reachable for a single body line whose real closing fence is
            // longer than the synthetic one (indented, CRLF or trailing text).
            return pageEndingAt(firstBodyLine, label);
        }

        // The first body line is longer than a page: cut it inside the fences.
        const cutLimit = offset + limit - header.length - ELLIPSIS.length - FENCE_CLOSE.length;
        if (firstBodyLine && cutLimit > firstBodyLine.start) {
            const cut = avoidSurrogateSplit(text, cutLimit, firstBodyLine.start);
            return {
                content: header + text.slice(offset, cut) + ELLIPSIS + FENCE_CLOSE,
                newOffset: cut,
                endedInCodeBlock: true,
                codeBlockType: label,
            };
        }

        // The limit cannot hold the fence markup plus any content.
        if (opener) return rawSplit(text, offset, limit, opener, label, null);
        if (firstBodyLine) return rawSplit(text, offset, limit, firstBodyLine, label, label);
        if (closer) return rawSplit(text, offset, limit, closer, null, null);
    }

    if (last) return pageEndingAt(last, null);
    return { content: "", newOffset: offset, endedInCodeBlock: false, codeBlockType: null };
}

/**
 * Splits markdown text into Discord-safe pages without breaking inside code blocks or tables.
 *
 * Returns the content of one page and the offset where the next page starts. Pages only
 * break on line boundaries; a code block spanning a boundary is closed on the current
 * page and re-opened on the next one with the same syntax label.
 *
 * The footer (`\nPage N of M`) is NOT appended here — the caller is responsible
 * for reserving space in `limit` and appending it after receiving the split content.
 *
 * @param text - The full transformed Discord text to paginate
 * @param offset - Character offset to start reading from (0 for page 1)
 * @param limit - Maximum character count of the returned content, including any
 *                synthetic fences (default: 2000, minimum: 1)
 * @param options - Optional flags, see {@link SplitMarkdownOptions}
 */
export function splitMarkdown(
    text: string,
    offset: number,
    limit: number = DEFAULT_LIMIT,
    options?: SplitMarkdownOptions,
): SplitMarkdownResult {
    // A page must be able to hold one character, or pagination could not progress.
    const pageLimit = Math.max(1, limit);

    if (!options?.pageCount) {
        return extractPage(text, offset, pageLimit, options?.continuationCodeBlock ?? null);
    }

    // Paginate the full text, keeping the first page that reaches past `offset`.
    let page = extractPage(text, 0, Math.max(1, options.firstPageLimit ?? pageLimit), null);
    let selected = page;
    let pageCount = 1;
    while (page.newOffset < text.length) {
        page = extractPage(text, page.newOffset, pageLimit, page.codeBlockType);
        if (selected.newOffset <= offset) selected = page;
        pageCount++;
    }
    return { ...selected, pageCount };
}
