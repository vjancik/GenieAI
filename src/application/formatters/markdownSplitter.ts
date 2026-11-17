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
 * Pages are a pure function of (text, offset, limit): whether an offset lies inside
 * a code block is derived from the text before it ({@link resumeStateAt}), so no
 * state has to be carried between pages, and paginating up-front and paginating
 * page by page always agree.
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
     * A page that starts inside a fenced code block opens with a synthetic
     * ` ```{label} ` line, and one that ends inside a block closes with ` ``` `.
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

/** Yields the classified lines of `text` from `from` on. Both `\n` and `\r\n` end a line. */
function* scanLines(text: string, from: number): Generator<Line> {
    let start = from;
    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const next = newline === -1 ? text.length : newline + 1;
        let end = newline === -1 ? text.length : newline;
        if (newline > start && text[newline - 1] === "\r") end--;
        yield { start, end, next, ...classify(text.slice(start, end)) };
        start = next;
    }
}

/**
 * The label of the code block that is open after `line`, given the one open before
 * it (`null` = none). This is the only place that decides what opens and closes a block.
 */
function codeLabelAfter(openLabel: string | null, line: Line): string | null {
    if (openLabel !== null) return line.kind === "fence" || line.kind === "inlineFence" ? null : openLabel;
    return line.kind === "fence" ? line.label : null;
}

/** Where and in which state a page starting at a given offset begins. */
interface ResumeState {
    /** Label of the code block open at the start of the page, or `null` when in prose. */
    openCodeLabel: string | null;
    /** Offset of the first character of the page. */
    start: number;
    /** True when the page starts in the middle of a line that an earlier page cut. */
    midLine: boolean;
}

/** Returns the line that starts at `lineStart`, or `undefined` at the end of the text. */
function lineAt(text: string, lineStart: number): Line | undefined {
    return scanLines(text, lineStart).next().value;
}

/** Returns the start of the line that holds the character at `index`. */
function lineStartOf(text: string, index: number): number {
    return index === 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
}

/**
 * Derives the state at `offset` from the text before it.
 *
 * A line cut by an earlier page has already taken effect: if it opened or closed
 * a code block, the rest of it belongs to the state that follows.
 */
function resumeStateAt(text: string, offset: number): ResumeState {
    // Only a line holding a fence can open or close a block, so the scan jumps from
    // one such line to the next instead of classifying every line.
    let openCodeLabel: string | null = null;
    let searchFrom = 0;
    while (searchFrom < offset) {
        const fenceAt = text.indexOf(FENCE, searchFrom);
        if (fenceAt === -1) break;
        const line = lineAt(text, lineStartOf(text, fenceAt));
        if (!line || line.start >= offset) break;
        openCodeLabel = codeLabelAfter(openCodeLabel, line);
        searchFrom = Math.max(line.next, fenceAt + FENCE.length);
    }

    const current = lineAt(text, lineStartOf(text, offset));
    if (current && current.start < offset) {
        if (offset < current.end) return { openCodeLabel, start: offset, midLine: true };
        // An offset on the line's terminator, as stored by the previous splitter,
        // resumes at the next line.
        if (offset < current.next) return { openCodeLabel, start: current.next, midLine: false };
    }
    return { openCodeLabel, start: offset, midLine: false };
}

/**
 * Collects the lines of the page starting at `start`.
 *
 * Stops after the first line that ends more than `horizon` characters past `start`:
 * neither that line nor any later one can be placed whole on a page of that size, so
 * the cost of packing a page does not grow with the length of the remaining text.
 *
 * @param midLine - When true, the first line is the rest of a cut line and is taken
 *                  as plain content, whatever it happens to start with.
 */
function tokenize(text: string, start: number, horizon: number, midLine: boolean): Line[] {
    const lines: Line[] = [];
    for (const line of scanLines(text, start)) {
        lines.push(midLine && lines.length === 0 ? { ...line, kind: "text", label: "" } : line);
        if (line.end - start > horizon) break;
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
            if (codeLabelAfter(code.label, line) === null) {
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
        const openedLabel = codeLabelAfter(null, line);
        if (openedLabel !== null) {
            code = { kind: "code", label: openedLabel, opener: line, body: [], closer: null };
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
 * is not fence-balanced.
 */
function rawSplit(text: string, start: number, limit: number, line: Line): Page {
    if (line.end - start <= limit) return { content: text.slice(start, line.end), newOffset: line.next };
    // A limit of 1 has no room for the ellipsis next to a character of content.
    const marker = limit > ELLIPSIS.length ? ELLIPSIS : "";
    const cut = avoidSurrogateSplit(text, start + limit - marker.length, start);
    return { content: text.slice(start, cut) + marker, newOffset: cut };
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
 */
function extractPage(text: string, offset: number, limit: number): Page {
    const { openCodeLabel, start, midLine } = resumeStateAt(text, offset);
    const lines = tokenize(text, start, limit, midLine);
    const blocks = parseBlocks(lines, openCodeLabel);
    // Re-opens the code block that is open where the page starts.
    const header = openCodeLabel !== null && lines.length > 0 ? `${FENCE}${openCodeLabel}\n` : "";

    /** Whether the page can end right after `line` with `reserve` characters of synthetic markup to spare. */
    const fits = (line: Line, reserve = 0) => header.length + (line.end - start) + reserve <= limit;
    const fitsWithClose = (line: Line) => fits(line, FENCE_CLOSE.length);

    /** Ends the page after `last`, closing the code block `openLabel` if one is open there. */
    const pageEndingAt = (last: Line, openLabel: string | null): Page => {
        const content = header + text.slice(start, last.end);
        if (openLabel !== null) {
            return {
                content: content + FENCE_CLOSE,
                newOffset: last.next,
            };
        }
        // Discord trims messages, so whitespace around a prose boundary is dropped:
        // the blank lines that follow are consumed here instead of opening the next
        // page, where they could add up to a message with nothing to display.
        return {
            content: content.trimEnd(),
            newOffset: skipBlankLines(text, last.next),
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
            return last && hasContent ? pageEndingAt(last, null) : rawSplit(text, start, limit, block.line);
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
            if (firstRow) return rawSplit(text, start, limit, firstRow);
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
        const cutLimit = start + limit - header.length - ELLIPSIS.length - FENCE_CLOSE.length;
        if (firstBodyLine && cutLimit > firstBodyLine.start) {
            const cut = avoidSurrogateSplit(text, cutLimit, firstBodyLine.start);
            return {
                content: header + text.slice(start, cut) + ELLIPSIS + FENCE_CLOSE,
                newOffset: cut,
            };
        }

        // The limit cannot hold the fence markup plus any content.
        if (opener) return rawSplit(text, start, limit, opener);
        if (firstBodyLine) return rawSplit(text, start, limit, firstBodyLine);
        if (closer) return rawSplit(text, start, limit, closer);
    }

    if (last) return pageEndingAt(last, null);
    return { content: "", newOffset: start };
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
        return extractPage(text, offset, pageLimit);
    }

    // Paginate the full text, keeping the first page that reaches past `offset`.
    let page = extractPage(text, 0, Math.max(1, options.firstPageLimit ?? pageLimit));
    let selected = page;
    let pageCount = 1;
    while (page.newOffset < text.length) {
        page = extractPage(text, page.newOffset, pageLimit);
        if (selected.newOffset <= offset) selected = page;
        pageCount++;
    }
    return { ...selected, pageCount };
}
