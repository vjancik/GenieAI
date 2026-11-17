import { splitMarkdown } from "../../src/application/formatters/markdownSplitter.ts";

/**
 * Invariant checker for {@link splitMarkdown}, shared by the brute-force fuzz run
 * and the unit tests. It paginates a text the way production does (page 1 with
 * `pageCount`, later pages by stored offset and code block label) and checks every
 * page against a reference scan of the source that is independent of the splitter.
 */

const FENCE = "```";
const FENCE_CLOSE = `\n${FENCE}`;
const ELLIPSIS = "…";

/**
 * Below this limit a page may be too small to hold a code block's fence markup next
 * to any content, so only the size, progress and coverage invariants are checked.
 * Must exceed the longest fence line, table row and inline-fence line of the text.
 */
export const MIN_STRUCTURED_LIMIT = 64;

export interface SplitPage {
    /** Source offset where the page starts. */
    offset: number;
    content: string;
    newOffset: number;
    endedInCodeBlock: boolean;
    codeBlockType: string | null;
    /** Limit that applied to this page. */
    limit: number;
}

export interface PaginationReport {
    pages: SplitPage[];
    /** Page count announced by the first call. */
    pageCount: number | undefined;
    /** Human-readable invariant violations; empty when the pagination is sound. */
    violations: string[];
}

interface SourceRange {
    start: number;
    end: number;
}

interface SourceCodeBlock {
    label: string;
    /** First offset at which a page boundary lies inside the block (start of its body). */
    bodyStart: number;
    /** Last such offset (start of the closing fence, or end of text if unterminated). */
    bodyEnd: number;
}

interface SourceStructure {
    tables: SourceRange[];
    codeBlocks: SourceCodeBlock[];
}

/** Reference scan: locates every table and fenced code block in the full text. */
function scanSource(text: string): SourceStructure {
    const tables: SourceRange[] = [];
    const codeBlocks: SourceCodeBlock[] = [];
    let openCode: SourceCodeBlock | null = null;
    let openTable: SourceRange | null = null;

    let start = 0;
    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const next = newline === -1 ? text.length : newline + 1;
        const line = text.slice(start, newline === -1 ? text.length : newline).replace(/\r$/, "");
        const trimmed = line.trimStart();
        const startsWithFence = trimmed.startsWith(FENCE);

        if (openCode) {
            if (startsWithFence) {
                openCode.bodyEnd = start;
                openCode = null;
            }
        } else if (startsWithFence && !trimmed.slice(FENCE.length).includes(FENCE)) {
            openTable = null;
            openCode = { label: trimmed.slice(FENCE.length).trimEnd(), bodyStart: next, bodyEnd: text.length };
            codeBlocks.push(openCode);
        } else if (trimmed.startsWith("|")) {
            if (!openTable) {
                openTable = { start, end: start };
                tables.push(openTable);
            }
            openTable.end = start + line.length;
        } else {
            openTable = null;
        }
        start = next;
    }
    return { tables, codeBlocks };
}

/** Whether every code fence opened in a page's content is closed again. */
function fencesAreBalanced(content: string): boolean {
    let inCode = false;
    for (const line of content.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith(FENCE)) continue;
        if (inCode) inCode = false;
        else if (!trimmed.slice(FENCE.length).includes(FENCE)) inCode = true;
    }
    return !inCode;
}

/**
 * Paginates `text` step by step and checks every page.
 *
 * @param firstPageLimit - Limit for page 1 only; defaults to `limit`.
 */
export function checkPagination(text: string, limit: number, firstPageLimit: number = limit): PaginationReport {
    const violations: string[] = [];
    const pages: SplitPage[] = [];
    const structured = Math.min(limit, firstPageLimit) >= MIN_STRUCTURED_LIMIT;
    const source = scanSource(text);

    const first = splitMarkdown(text, 0, limit, { pageCount: true, firstPageLimit });
    const pageCount = first.pageCount;
    pages.push({ ...first, offset: 0, limit: firstPageLimit });

    for (let previous = pages[0]; previous && previous.newOffset < text.length; previous = pages.at(-1)) {
        if (previous.newOffset <= previous.offset) break;
        const page = splitMarkdown(text, previous.newOffset, limit, {
            continuationCodeBlock: previous.endedInCodeBlock ? previous.codeBlockType : null,
        });
        pages.push({ ...page, offset: previous.newOffset, limit });
    }

    pages.forEach((page, index) => {
        const where = `limit ${limit}/${firstPageLimit}, page ${index + 1} @${page.offset}`;
        const fail = (message: string) => violations.push(`${where}: ${message}`);
        const previous = index > 0 ? pages[index - 1] : undefined;

        if (page.content.length > page.limit) fail(`content is ${page.content.length} chars`);
        if (page.newOffset <= page.offset) fail("made no progress");
        if (page.newOffset > text.length) fail("ran past the end of the text");
        if (page.endedInCodeBlock !== (page.codeBlockType !== null)) fail("inconsistent code block state");

        // The content must be the page's source slice, plus nothing but known synthetic markup.
        const slice = text.slice(page.offset, page.newOffset);
        const header = previous?.endedInCodeBlock ? `${FENCE}${previous.codeBlockType}\n` : "";
        const close = page.endedInCodeBlock ? FENCE_CLOSE : "";
        const bodies = page.endedInCodeBlock ? [slice.replace(/\r?\n$/, "")] : [slice, slice.trimEnd()];
        const candidates = bodies.flatMap((body) =>
            [...new Set([header, ""])].flatMap((h) =>
                [...new Set([close, ""])].flatMap((c) => [h + body + c, h + body + ELLIPSIS + c]),
            ),
        );
        if (!candidates.includes(page.content)) fail("content is not the source slice plus synthetic markup");

        if (!structured) return;

        if (page.content.trim() === "") fail("content is blank");
        if (!page.content.startsWith(header)) fail("missing code block re-opening header");
        if (!page.content.endsWith(close)) fail("missing synthetic closing fence");
        if (!fencesAreBalanced(page.content)) fail("unbalanced code fences");

        // The reported code block state must match the source at the page boundary.
        const boundary = page.newOffset;
        const block = source.codeBlocks.find((b) => boundary >= b.bodyStart && boundary <= b.bodyEnd);
        const expectedLabel = block ? block.label : null;
        if (page.codeBlockType !== expectedLabel) {
            fail(
                `reports code block ${JSON.stringify(page.codeBlockType)}, source has ${JSON.stringify(expectedLabel)}`,
            );
        }

        // A table that fits on a page is never split.
        const splitTable = source.tables.find((t) => boundary > t.start && boundary < t.end);
        if (splitTable && splitTable.end - splitTable.start <= Math.min(limit, firstPageLimit)) {
            fail(`splits the table at ${splitTable.start}`);
        }
    });

    if (pages.at(-1)?.newOffset !== text.length) violations.push(`limit ${limit}: pages do not cover the text`);
    if (pageCount !== pages.length) {
        violations.push(`limit ${limit}/${firstPageLimit}: pageCount ${pageCount} but ${pages.length} pages produced`);
    }

    return { pages, pageCount, violations };
}
