/**
 * Markdown-aware text splitter for Discord's 2000-character message limit.
 *
 * Splits text only on newline boundaries, and never inside fenced code blocks
 * or markdown tables, to avoid broken rendering in Discord.
 */

/** Options for {@link splitMarkdown}. */
export interface SplitMarkdownOptions {
    /**
     * When true, the function performs a full scan of the text from offset 0
     * and includes `pageCount` in the return value. Used by the caller to
     * compute the footer string before sending page 1.
     */
    pageCount?: true;
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
}

/** Default Discord message character limit. */
const DEFAULT_LIMIT = 2000;

/**
 * Regex matching a fenced code block opening/closing line.
 * CommonMark allows up to 3 leading spaces before the fence.
 */
const CODE_FENCE_RE = /^ {0,3}```/;

/**
 * Regex matching a markdown table separator line (e.g. `| :--- | --- |`).
 * Used together with the `|`-prefix check to detect table rows.
 */
const TABLE_SEPARATOR_RE = /^\|[\s|:-]+\|?\s*$/;

/**
 * Extracts one page of content from `text` starting at `offset`, up to `limit` characters.
 *
 * Splitting rules:
 * - Only splits on newline boundaries (never mid-line)
 * - Never splits inside a fenced code block (``` ... ```) — backs up to the last
 *   safe position before the block opened
 * - Never splits inside a markdown table — backs up similarly
 * - If a protected block begins at the very start of this page (no safe backup point),
 *   falls back to a hard split at `limit` characters to avoid an infinite loop
 */
function extractPage(text: string, offset: number, limit: number): { content: string; newOffset: number } {
    const slice = text.slice(offset);
    const lines = slice.split("\n");

    let inCodeBlock = false;
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
        if (CODE_FENCE_RE.test(line)) {
            inCodeBlock = !inCodeBlock;
        }

        // Detect table context: a line starting with | (content row) or a separator line,
        // but only outside code blocks.
        inTable = !inCodeBlock && (line.trimStart().startsWith("|") || TABLE_SEPARATOR_RE.test(line.trim()));

        // Check whether adding this line would exceed the limit
        if (accumulated.length + addition.length > limit) {
            if (inCodeBlock || inTable || lastSafeLength < accumulated.length) {
                // We are inside a protected block or just entered one — back up to the last safe position.
                // If lastSafeLength === 0, there is no safe backup point (the block opened before any
                // splittable content). Hard-split at the limit to avoid returning an empty/zero-progress page.
                if (lastSafeLength === 0) {
                    return { content: text.slice(offset, offset + limit), newOffset: offset + limit };
                }
                const safeContent = accumulated.slice(0, lastSafeLength);
                return { content: safeContent, newOffset: offset + safeContent.length };
            }
            // Normal case: not in a protected block — split before this line
            break;
        }

        accumulated += addition;
    }

    return { content: accumulated, newOffset: offset + accumulated.length };
}

/**
 * Paginates the full text from offset 0, returning every page as `{ content, newOffset }`.
 * Always returns at least one entry (empty page for empty text).
 */
function extractAllPages(text: string, limit: number): Array<{ content: string; newOffset: number }> {
    if (text.length === 0) return [{ content: "", newOffset: 0 }];

    const pages: Array<{ content: string; newOffset: number }> = [];
    let offset = 0;

    while (offset < text.length) {
        const page = extractPage(text, offset, limit);
        pages.push(page);
        // Guard against infinite loop if extractPage makes no progress
        if (page.newOffset <= offset) break;
        offset = page.newOffset;
    }

    return pages;
}

/**
 * Splits markdown text into Discord-safe pages without breaking inside code blocks or tables.
 *
 * Splitting rules:
 * - Only splits on newline boundaries (never mid-line)
 * - Never splits inside a fenced code block (``` ... ```)
 * - Never splits inside a markdown table (consecutive lines starting with `|`)
 * - Returns the content for one page and the offset where the next page starts
 *
 * The footer (`\nPage N of M`) is NOT appended here — the caller is responsible
 * for reserving space in `limit` and appending it after receiving the split content.
 *
 * When `options.pageCount` is true, all pages are computed up-front (from offset 0)
 * and the requested page is looked up from that list — avoiding a redundant extractPage call.
 *
 * @param text - The full transformed Discord text to paginate
 * @param offset - Character offset to start reading from (0 for page 1)
 * @param limit - Maximum character count for the returned content (default: 2000)
 * @param options - Optional: pass `{ pageCount: true }` to also compute total page count
 */
export function splitMarkdown(
    text: string,
    offset: number,
    limit: number = DEFAULT_LIMIT,
    options?: SplitMarkdownOptions,
): SplitMarkdownResult {
    if (!options?.pageCount) {
        return extractPage(text, offset, limit);
    }

    // pageCount requested: paginate the full text once, find the page at `offset`
    const allPages = extractAllPages(text, limit);
    const page = allPages.find((p) => p.newOffset > offset || p.newOffset === text.length);
    // only to satisfy typechecker, should never throw
    if (!page) throw new Error(`splitMarkdown: no page found for offset ${offset} in text of length ${text.length}`);
    return { content: page.content, newOffset: page.newOffset, pageCount: allPages.length };
}
