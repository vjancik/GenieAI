/**
 * Markdown-aware text splitter for Discord's 2000-character message limit.
 *
 * Splits text only on newline boundaries, and never inside fenced code blocks
 * or markdown tables, to avoid broken rendering in Discord.
 *
 * When a page boundary falls inside a fenced code block, the page is closed with
 * a ``` terminator and the next page is opened with the matching ``` opener, so
 * each Discord message is a self-contained, valid markdown document.
 */

// TODO: refactor as a formal state machine parser

/** Options for {@link splitMarkdown}. */
export interface SplitMarkdownOptions {
    /**
     * When true, the function performs a full scan of the text from offset 0
     * and includes `pageCount` in the return value. Used by the caller to
     * compute the footer string before sending page 1.
     */
    pageCount?: true;
    /**
     * When the previous page ended inside a fenced code block, pass the syntax
     * label (e.g. `"typescript"`) or an empty string for unlabelled blocks here.
     * The splitter will prepend ` ```{label}\n ` to the content of this page
     * (without advancing the underlying text offset) so the code block renders
     * correctly in Discord.
     *
     * Must be `null` or omitted when the previous page did not end in a code block.
     */
    continuationCodeBlock?: string | null;
    /**
     * Override the character limit for page 1 only (e.g. when the first page carries
     * a header/footer overhead that subsequent pages do not). Only meaningful when
     * `pageCount` is true — the full scan uses this limit for page 0 so the total
     * page count correctly reflects the reduced first-page capacity.
     */
    firstPageLimit?: number;
}

/** Result of a {@link splitMarkdown} call. */
export interface SplitMarkdownResult {
    /** The content to display for this page (without footer — caller appends it). */
    content: string;
    /** Character offset in the original text where this page ends (= start of next page). */
    newOffset: number;
    /**
     * Total page count for the full text at the given limit.
     * Only present when `options.pageCount === true` was passed.
     */
    pageCount?: number;
    /**
     * True when this page ended mid-way through a fenced code block and the block
     * was closed with a synthetic ``` terminator. The next page must be opened with
     * the matching ``` opener (see {@link SplitMarkdownOptions.continuationCodeBlock}).
     */
    endedInCodeBlock: boolean;
    /**
     * The syntax label of the open code block at the page boundary (e.g. `"typescript"`),
     * or an empty string for an unlabelled block. `null` when `endedInCodeBlock` is false.
     */
    codeBlockType: string | null;
}

/** Default Discord message character limit. */
const DEFAULT_LIMIT = 2000;

/**
 * Regex matching a fenced code block opening/closing line.
 * CommonMark allows up to 3 leading spaces before the fence.
 * Capture group 1 captures the optional syntax label on an opening fence.
 */
const CODE_FENCE_RE = /^ {0,3}```(.*)$/;

/**
 * Regex matching a markdown table separator line (e.g. `| :--- | --- |`).
 * Used together with the `|`-prefix check to detect table rows.
 */
const TABLE_SEPARATOR_RE = /^\|[\s|:-]+\|?\s*$/;

/** Closing fence added to page content when a split falls inside a code block. */
const CODE_FENCE_CLOSE = "\n```";

/** Ellipsis appended to hard-split content to signal truncation mid-line. */
const HARD_SPLIT_ELLIPSIS = "…";

/**
 * Returns the content and newOffset for a hard split at `limit` characters.
 * Reserves {@link HARD_SPLIT_ELLIPSIS}.length characters for the trailing ellipsis
 * so the reader knows the line continues.
 */
function hardSplit(text: string, offset: number, limit: number): Omit<SplitMarkdownResult, "pageCount"> {
    const cutoff = limit - HARD_SPLIT_ELLIPSIS.length;
    return {
        content: text.slice(offset, offset + cutoff) + HARD_SPLIT_ELLIPSIS,
        newOffset: offset + cutoff,
        endedInCodeBlock: false,
        codeBlockType: null,
    };
}

/**
 * Builds the continuation header prepended to a page that resumes an open code block.
 * Not counted toward text offsets — it is purely cosmetic markup.
 */
function buildContinuationHeader(codeBlockType: string): string {
    return codeBlockType ? `\`\`\`${codeBlockType}\n` : "```\n";
}

/**
 * Extracts one page of content from `text` starting at `offset`, up to `limit` characters.
 *
 * Splitting rules:
 * - Only splits on newline boundaries (never mid-line)
 * - Never splits inside a fenced code block (``` ... ```) — instead appends a closing ```
 *   fence to the page content and records the block's syntax label in the result so the
 *   next page can open with a matching ``` opener
 * - Never splits inside a markdown table — backs up to last safe position
 * - If a protected block begins at the very start of this page (no safe backup point),
 *   falls back to a hard split at `limit` characters to avoid an infinite loop
 *
 * @param text - The full text to paginate
 * @param offset - Character offset to start reading from
 * @param limit - Maximum character count for the returned page content (excluding any
 *                continuation header prepended for caller display — the header does not
 *                consume limit budget)
 * @param continuationCodeBlock - When resuming a code block from a previous page, this
 *                                is the syntax label (or "") to prepend as a continuation
 *                                header. Does not consume limit budget.
 */
function extractPage(
    text: string,
    offset: number,
    limit: number,
    continuationCodeBlock?: string | null,
): Omit<SplitMarkdownResult, "pageCount"> {
    const slice = text.slice(offset);
    // Output: ["First line", "\nSecond line", "\r\nThird line"]
    const lines = slice.split(/(?=\r?\n)/);

    // If we are continuing inside a code block from the previous page, start as already
    // inside a code block. The continuation header is prepended to content for display
    // but does NOT advance the underlying text offset.
    let inCodeBlock = continuationCodeBlock != null;
    // Track the syntax label of the currently open code block (empty string = unlabelled).
    let currentCodeBlockType: string = continuationCodeBlock ?? "";
    let inTable = false;
    let accumulated = "";

    // Last accumulated length at which a split is safe (outside code/table regions)
    let lastSafeLength = 0;
    // accumulated length at the point the current code block opened (i.e. after the opening
    // fence line was added). Any newline-boundary split inside the block must be after this
    // position to guarantee we make forward progress past the opening fence.
    let codeBlockStartLength = continuationCodeBlock != null ? 0 : -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Bounds are guaranteed by the loop condition — this branch is unreachable
        if (line === undefined) break;

        // Record the safe split point BEFORE updating block state for this line.
        // This ensures that if this line opens a protected block (opening fence or first
        // table row), we can back up to just before it.
        if (!inCodeBlock && !inTable) {
            lastSafeLength = accumulated.length;
        }

        // Detect code fence toggle. A fence always starts with ``` (up to 3 leading spaces).
        const fenceMatch = CODE_FENCE_RE.exec(line.trimStart());
        // Whether this line is a closing fence (block was open before this line).
        const isClosingFence = !!(fenceMatch && inCodeBlock);
        // Preserve the block type before a closing fence clears it, so the over-limit
        // closing-fence branch below can still report the correct syntax label.
        const closingFenceBlockType = isClosingFence ? currentCodeBlockType : null;

        if (fenceMatch) {
            if (!inCodeBlock) {
                // Opening fence — record the syntax label (may be empty string)
                inCodeBlock = true;
                // fenceMatch[1] is the captured label, trimmed of trailing whitespace
                currentCodeBlockType = (fenceMatch[1] ?? "").trimEnd();
            } else {
                // Closing fence — exiting the block. Update lastSafeLength here so that
                // the closing fence line itself is a valid split point: if the next line
                // would exceed the limit, we can include up to and including this fence
                // rather than backing all the way up to before the opening fence.
                inCodeBlock = false;
                currentCodeBlockType = "";
                codeBlockStartLength = -1;
                lastSafeLength = accumulated.length;
            }
        }

        // After accumulating the opening fence line, record how far we are so that any
        // intra-block newline split must be strictly after this position.
        if (inCodeBlock && codeBlockStartLength === -1) {
            codeBlockStartLength = accumulated.length + line.length;
        }

        // Detect table context: a line starting with | (content row) or a separator line,
        // but only outside code blocks.
        inTable = !inCodeBlock && (line.trimStart().startsWith("|") || TABLE_SEPARATOR_RE.test(line.trim()));

        // Check whether adding this line would exceed the limit
        if (accumulated.length + line.length > limit) {
            // Special case: the closing fence itself doesn't fit. The block body is already
            // in `accumulated` but without the fence it would render as unterminated.
            // Treat it the same as a mid-block split: backtrack to the last newline inside
            // the block that still leaves room for the synthetic closing fence.
            if (isClosingFence) {
                const fenceRoom = limit - CODE_FENCE_CLOSE.length;
                const searchRegion = accumulated.slice(0, fenceRoom);
                const lastNl = searchRegion.lastIndexOf("\n");
                // codeBlockStartLength was reset to -1 by the closing fence branch above,
                // so reconstruct the floor: any position > 0 inside the block is fine.
                if (lastNl > 0) {
                    return {
                        content: accumulated.slice(0, lastNl) + CODE_FENCE_CLOSE,
                        newOffset: offset + lastNl,
                        endedInCodeBlock: true,
                        codeBlockType: closingFenceBlockType,
                    };
                }
                // No viable newline inside the block — hard split
                return {
                    ...hardSplit(text, offset, limit),
                };
            }

            if (inTable || (lastSafeLength < accumulated.length && !inCodeBlock)) {
                // Inside a table or just entered one — back up to last safe position.
                if (lastSafeLength === 0) {
                    // No safe backup point — hard split to avoid infinite loop
                    return {
                        content: text.slice(offset, offset + limit),
                        newOffset: offset + limit,
                        endedInCodeBlock: false,
                        codeBlockType: null,
                    };
                }
                const safeContent = accumulated.slice(0, lastSafeLength);
                return {
                    content: safeContent,
                    newOffset: offset + safeContent.length,
                    endedInCodeBlock: false,
                    codeBlockType: null,
                };
            }

            if (inCodeBlock) {
                // Splitting mid-code-block: append the synthetic closing fence IF it fits
                // within the limit. accumulated + CODE_FENCE_CLOSE must be <= limit.
                if (accumulated.length === 0) {
                    // No content accumulated at all — hard split to avoid zero-progress.
                    return {
                        content: text.slice(offset, offset + limit),
                        newOffset: offset + limit,
                        endedInCodeBlock: false,
                        codeBlockType: null,
                    };
                }
                if (accumulated.length + CODE_FENCE_CLOSE.length <= limit) {
                    // Closing fence fits — close gracefully and signal continuation to caller.
                    // newOffset stays at accumulated.length (synthetic fence is not in real text).
                    return {
                        content: accumulated + CODE_FENCE_CLOSE,
                        newOffset: offset + accumulated.length,
                        endedInCodeBlock: true,
                        codeBlockType: currentCodeBlockType,
                    };
                }
                // Closing fence does not fit — find the last newline within the budget
                // that leaves room for the fence, and that is still inside the code block
                // (i.e. after the opening fence line, so we always make forward progress).
                const fenceRoom = limit - CODE_FENCE_CLOSE.length;
                const searchRegion = accumulated.slice(0, fenceRoom);
                const lastNl = searchRegion.lastIndexOf("\n");
                if (lastNl > codeBlockStartLength) {
                    // There is a line boundary inside the block within budget — split there.
                    const splitContent = accumulated.slice(0, lastNl) + CODE_FENCE_CLOSE;
                    return {
                        content: splitContent,
                        newOffset: offset + lastNl,
                        endedInCodeBlock: true,
                        codeBlockType: currentCodeBlockType,
                    };
                }
                // No viable newline found inside the block — fall back to the last safe
                // position before the block opened (same as the table backup path).
                if (lastSafeLength === 0) {
                    return {
                        content: text.slice(offset, offset + limit),
                        newOffset: offset + limit,
                        endedInCodeBlock: false,
                        codeBlockType: null,
                    };
                }
                const safeContent = accumulated.slice(0, lastSafeLength);
                return {
                    content: safeContent,
                    newOffset: offset + safeContent.length,
                    endedInCodeBlock: false,
                    codeBlockType: null,
                };
            }

            // Normal case: not in a protected block — split before this line.
            // If accumulated is empty the current line itself exceeds the limit (no
            // newline to split on). Hard-split at limit to guarantee forward progress.
            if (accumulated.length === 0) {
                return {
                    ...hardSplit(text, offset, limit),
                };
            }
            break;
        }

        accumulated += line;
    }

    // We fell through the loop — either the whole slice fits, or we broke out normally.
    // Check if we ended inside a code block (e.g. the last line opened one without closing).
    if (inCodeBlock && accumulated.length > 0) {
        // Only append the closing fence if it fits within the limit.
        // accumulated.length is guaranteed <= limit here, but adding 4 fence chars
        // could overflow — guard to be safe.
        if (accumulated.length + CODE_FENCE_CLOSE.length <= limit) {
            return {
                content: accumulated + CODE_FENCE_CLOSE,
                newOffset: offset + accumulated.length,
                endedInCodeBlock: true,
                codeBlockType: currentCodeBlockType,
            };
        }
        // No room for the fence — return what we have without it; caller will see
        // endedInCodeBlock=false and won't prepend a continuation header, which is
        // the safest fallback for this pathological edge case.
        return {
            content: accumulated,
            newOffset: offset + accumulated.length,
            endedInCodeBlock: false,
            codeBlockType: null,
        };
    }

    return {
        content: accumulated,
        newOffset: offset + accumulated.length,
        endedInCodeBlock: false,
        codeBlockType: null,
    };
}

/**
 * Paginates the full text from offset 0, returning every page as an extractPage result.
 * Always returns at least one entry (empty page for empty text).
 * Threads `endedInCodeBlock`/`codeBlockType` from each page to the next as a continuation header.
 *
 * @param firstPageLimit - Optional override limit for page 0 only (e.g. when page 1 carries
 *                         overhead that subsequent pages do not). Defaults to `limit`.
 */
function extractAllPages(
    text: string,
    limit: number,
    firstPageLimit?: number,
): Array<Omit<SplitMarkdownResult, "pageCount">> {
    if (text.length === 0) {
        return [{ content: "", newOffset: 0, endedInCodeBlock: false, codeBlockType: null }];
    }

    const pages: Array<Omit<SplitMarkdownResult, "pageCount">> = [];
    let offset = 0;
    let continuationCodeBlock: string | null = null;

    while (offset < text.length) {
        const pageLimit = pages.length === 0 ? (firstPageLimit ?? limit) : limit;
        const page = extractPage(text, offset, pageLimit, continuationCodeBlock);
        pages.push(page);
        // Guard against infinite loop if extractPage makes no progress
        if (page.newOffset <= offset) break;
        offset = page.newOffset;
        // If this page ended mid-block, the next page must prepend the continuation header
        continuationCodeBlock = page.endedInCodeBlock ? page.codeBlockType : null;
    }

    return pages;
}

/**
 * Splits markdown text into Discord-safe pages without breaking inside code blocks or tables.
 *
 * Splitting rules:
 * - Only splits on newline boundaries (never mid-line)
 * - Never splits inside a fenced code block (``` ... ```) — closes with ``` on the current
 *   page and re-opens with the same ``` opener on the next page
 * - Never splits inside a markdown table (consecutive lines starting with `|`)
 * - Returns the content for one page and the offset where the next page starts
 *
 * The footer (`\nPage N of M`) is NOT appended here — the caller is responsible
 * for reserving space in `limit` and appending it after receiving the split content.
 *
 * When `options.continuationCodeBlock` is provided (non-null), the returned `content`
 * is prefixed with a ` ```{label}\n` header. This prefix does NOT advance `newOffset`
 * and must not be counted toward character limits for subsequent pages.
 *
 * When `options.pageCount` is true, all pages are computed up-front (from offset 0)
 * and the requested page is looked up from that list — avoiding a redundant extractPage call.
 *
 * @param text - The full transformed Discord text to paginate
 * @param offset - Character offset to start reading from (0 for page 1)
 * @param limit - Maximum character count for the returned content (default: 2000)
 * @param options - Optional flags: `pageCount`, `continuationCodeBlock`
 */
export function splitMarkdown(
    text: string,
    offset: number,
    limit: number = DEFAULT_LIMIT,
    options?: SplitMarkdownOptions,
): SplitMarkdownResult {
    const continuationCodeBlock = options?.continuationCodeBlock ?? null;

    if (!options?.pageCount) {
        const result = extractPage(text, offset, limit, continuationCodeBlock);
        const content =
            continuationCodeBlock != null
                ? buildContinuationHeader(continuationCodeBlock) + result.content
                : result.content;
        return { ...result, content };
    }

    // pageCount requested: paginate the full text once, find the page at `offset`
    const allPages = extractAllPages(text, limit, options?.firstPageLimit);
    const page = allPages.find((p) => p.newOffset > offset || p.newOffset === text.length);
    // only to satisfy typechecker, should never throw
    if (!page) throw new Error(`splitMarkdown: no page found for offset ${offset} in text of length ${text.length}`);

    const content =
        continuationCodeBlock != null ? buildContinuationHeader(continuationCodeBlock) + page.content : page.content;

    return { ...page, content, pageCount: allPages.length };
}
