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
    const lines = slice.split("\n");

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

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Bounds are guaranteed by the loop condition — this branch is unreachable
        if (line === undefined) break;
        // First line has no preceding newline separator; subsequent lines do
        const addition = i === 0 ? line : `\n${line}`;

        // Record the safe split point BEFORE updating block state for this line.
        // This ensures that if this line opens a protected block, we can back up to
        // just before it (i.e. to the end of the previously accumulated safe content).
        if (!inCodeBlock && !inTable) {
            lastSafeLength = accumulated.length;
        }

        // Detect code fence toggle. A fence always starts with ``` (up to 3 leading spaces).
        const fenceMatch = CODE_FENCE_RE.exec(line);
        if (fenceMatch) {
            if (!inCodeBlock) {
                // Opening fence — record the syntax label (may be empty string)
                inCodeBlock = true;
                // fenceMatch[1] is the captured label, trimmed of trailing whitespace
                currentCodeBlockType = (fenceMatch[1] ?? "").trimEnd();
            } else {
                // Closing fence — exiting the block; record safe position after this line
                inCodeBlock = false;
                currentCodeBlockType = "";
            }
        }

        // Detect table context: a line starting with | (content row) or a separator line,
        // but only outside code blocks.
        inTable = !inCodeBlock && (line.trimStart().startsWith("|") || TABLE_SEPARATOR_RE.test(line.trim()));

        // Check whether adding this line would exceed the limit
        if (accumulated.length + addition.length > limit) {
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
                // Closing fence does not fit in the budget — back up to the last safe position
                // outside the block so the fence can be emitted cleanly on the next attempt.
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

            // Normal case: not in a protected block — split before this line
            break;
        }

        accumulated += addition;
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
 */
function extractAllPages(text: string, limit: number): Array<Omit<SplitMarkdownResult, "pageCount">> {
    if (text.length === 0) {
        return [{ content: "", newOffset: 0, endedInCodeBlock: false, codeBlockType: null }];
    }

    const pages: Array<Omit<SplitMarkdownResult, "pageCount">> = [];
    let offset = 0;
    let continuationCodeBlock: string | null = null;

    while (offset < text.length) {
        const page = extractPage(text, offset, limit, continuationCodeBlock);
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
    const allPages = extractAllPages(text, limit);
    const page = allPages.find((p) => p.newOffset > offset || p.newOffset === text.length);
    // only to satisfy typechecker, should never throw
    if (!page) throw new Error(`splitMarkdown: no page found for offset ${offset} in text of length ${text.length}`);

    const content =
        continuationCodeBlock != null ? buildContinuationHeader(continuationCodeBlock) + page.content : page.content;

    return { ...page, content, pageCount: allPages.length };
}
