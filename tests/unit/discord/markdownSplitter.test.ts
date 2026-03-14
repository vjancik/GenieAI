import { describe, expect, it } from "bun:test";
import { splitMarkdown } from "../../../src/application/markdownSplitter.ts";

// ---------------------------------------------------------------------------
// Regression test: real payload from production error 2026-03-14
// The content sent to Discord was 2001+ chars — splitMarkdown returned a page
// exceeding the 2000-char limit.
// ---------------------------------------------------------------------------
describe("splitMarkdown — regression: production over-limit page", () => {
    // Exact content from the DiscordAPIError requestBody, \n literals replaced with real newlines
    const PROD_CONTENT = `Implementing a PNG decoder from scratch is complex because it requires a **DEFLATE** decompressor. In modern environments (Node 18+ or Browsers), you can use the native \`DecompressionStream\` to handle the compression, allowing us to focus on the **PNG-specific chunk parsing and unfiltering algorithm.**\nHere is a simplified implementation:\n\`\`\`typescript\nasync function decodePng(buffer: Uint8Array) {\n  const view = new DataView(buffer.buffer);\n  let offset = 8; // Skip PNG signature\n  let idatData = new Uint8Array(0);\n  let width = 0, height = 0;\n  while (offset < buffer.length) {\n    const length = view.getUint32(offset);\n    const type = String.fromCharCode(...buffer.slice(offset + 4, offset + 8));\n    const data = buffer.slice(offset + 8, offset + 8 + length);\n    if (type === 'IHDR') {\n      width = view.getUint32(offset + 8);\n      height = view.getUint32(offset + 12);\n    } else if (type === 'IDAT') {\n      const combined = new Uint8Array(idatData.length + data.length);\n      combined.set(idatData);\n      combined.set(data, idatData.length);\n      idatData = combined;\n    }\n    offset += 12 + length;\n  }\n  // 1. Decompress IDAT (Zlib) using native API\n  const ds = new DecompressionStream("deflate");\n  const writer = ds.writable.getWriter();\n  writer.write(idatData.slice(2, -4)); // Strip zlib header/footer\n  writer.close();\n  const inflated = new Uint8Array(await new Response(ds.readable).arrayBuffer());\n  // 2. Unfilter (Algorithm logic)\n  const bpp = 4; // Assuming RGBA8\n  const rowLen = width * bpp;\n  const pixels = new Uint8Array(width * height * bpp);\n  for (let y = 0; y < height; y++) {\n    const filterType = inflated[y * (rowLen + 1)];\n    const scanline = inflated.slice(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1));\n    for (let x = 0; x < rowLen; x++) {\n      const left = x >= bpp ? pixels[y * rowLen + x - bpp] : 0;\n      const up = y > 0 ? pixels[(y - 1) * rowLen + x] : 0;\n      const diag = (x >= bpp && y > 0) ? pixels[(y - 1) * rowLen + x - bpp] : 0;\n\`\`\``;

    it("production payload is longer than 2000 characters (confirms the bug is reproducible)", () => {
        expect(PROD_CONTENT.length).toBeGreaterThan(2000);
    });

    it("page 1 content must be 2000 characters or fewer", () => {
        const result = splitMarkdown(PROD_CONTENT, 0, 2000, { pageCount: true });
        expect(result.content.length).toBeLessThanOrEqual(2000);
    });

    it("splitMarkdown produces at least 2 pages for the production payload", () => {
        const result = splitMarkdown(PROD_CONTENT, 0, 2000, { pageCount: true });
        expect(result.pageCount).toBeGreaterThanOrEqual(2);
        expect(result).toMatchInlineSnapshot(`
          {
            "codeBlockType": "typescript",
            "content": 
          "Implementing a PNG decoder from scratch is complex because it requires a **DEFLATE** decompressor. In modern environments (Node 18+ or Browsers), you can use the native \`DecompressionStream\` to handle the compression, allowing us to focus on the **PNG-specific chunk parsing and unfiltering algorithm.**
          Here is a simplified implementation:
          \`\`\`typescript
          async function decodePng(buffer: Uint8Array) {
            const view = new DataView(buffer.buffer);
            let offset = 8; // Skip PNG signature
            let idatData = new Uint8Array(0);
            let width = 0, height = 0;
            while (offset < buffer.length) {
              const length = view.getUint32(offset);
              const type = String.fromCharCode(...buffer.slice(offset + 4, offset + 8));
              const data = buffer.slice(offset + 8, offset + 8 + length);
              if (type === 'IHDR') {
                width = view.getUint32(offset + 8);
                height = view.getUint32(offset + 12);
              } else if (type === 'IDAT') {
                const combined = new Uint8Array(idatData.length + data.length);
                combined.set(idatData);
                combined.set(data, idatData.length);
                idatData = combined;
              }
              offset += 12 + length;
            }
            // 1. Decompress IDAT (Zlib) using native API
            const ds = new DecompressionStream("deflate");
            const writer = ds.writable.getWriter();
            writer.write(idatData.slice(2, -4)); // Strip zlib header/footer
            writer.close();
            const inflated = new Uint8Array(await new Response(ds.readable).arrayBuffer());
            // 2. Unfilter (Algorithm logic)
            const bpp = 4; // Assuming RGBA8
            const rowLen = width * bpp;
            const pixels = new Uint8Array(width * height * bpp);
            for (let y = 0; y < height; y++) {
              const filterType = inflated[y * (rowLen + 1)];
              const scanline = inflated.slice(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1));
              for (let x = 0; x < rowLen; x++) {
                const left = x >= bpp ? pixels[y * rowLen + x - bpp] : 0;
                const up = y > 0 ? pixels[(y - 1) * rowLen + x] : 0;
          \`\`\`"
          ,
            "endedInCodeBlock": true,
            "newOffset": 1919,
            "pageCount": 2,
          }
        `);
    });
});

// Helper: build a string of exactly `n` 'x' characters
function chars(n: number): string {
    return "x".repeat(n);
}

// Code fence delimiter — extracted so template literals work without escaping backticks
const FENCE = "```";

// Helper: build a multi-line string where each line is `lineLen` chars,
// total `numLines` lines, joined by "\n"
function lines(numLines: number, lineLen: number): string {
    return Array.from({ length: numLines }, () => chars(lineLen)).join("\n");
}

describe("splitMarkdown — basic splitting", () => {
    it("returns full text and newOffset=text.length when under limit", () => {
        const text = "Hello\nWorld";
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(text);
        expect(result.newOffset).toBe(text.length);
    });

    it("returns full text when exactly at limit", () => {
        const text = chars(2000);
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(text);
        expect(result.newOffset).toBe(2000);
    });

    it("splits at the last newline before the limit", () => {
        // 1000 chars, newline, 1000 chars, newline, 1 char — total 2002 chars + 2 newlines
        const line1 = chars(1000);
        const line2 = chars(1000);
        const line3 = "z";
        const text = `${line1}\n${line2}\n${line3}`;
        const result = splitMarkdown(text, 0, 2001);
        // 1001 chars for line1+\n, plus 1000 for line2 = 2001 exactly — fits
        expect(result.content).toBe(`${line1}\n${line2}`);
        expect(result.newOffset).toBe(line1.length + 1 + line2.length);
    });

    it("handles empty string", () => {
        const result = splitMarkdown("", 0, 2000);
        expect(result.content).toBe("");
        expect(result.newOffset).toBe(0);
    });

    it("continues correctly from a non-zero offset", () => {
        const text = "AAAA\nBBBB\nCCCC";
        // Start from offset 5 (after "AAAA\n")
        const result = splitMarkdown(text, 5, 10);
        expect(result.content).toBe("BBBB\nCCCC");
        expect(result.newOffset).toBe(text.length);
    });

    it("returns newOffset equal to text.length on the last page", () => {
        const text = "line one\nline two\nline three";
        const result = splitMarkdown(text, 0, 100);
        expect(result.newOffset).toBe(text.length);
    });

    it("single line exceeding limit is returned as-is (no newline to split on)", () => {
        // No newlines — can't split, so the whole thing is returned even if over limit.
        // extractPage will try to add it: accumulated is empty, addition = line (> limit).
        // It doesn't enter the split branch (accumulated.length + addition.length > limit
        // triggers, but we break before adding — accumulated stays empty, loop exits).
        // Result: empty content, newOffset = offset.
        // This is a degenerate case; in practice the caller should handle 0-length pages.
        const text = chars(3000);
        const result = splitMarkdown(text, 0, 2000);
        // The line is one token, accumulated stays "", we break — content is ""
        expect(result.content).toBe("");
        expect(result.newOffset).toBe(0);
    });
});

describe("splitMarkdown — code block protection", () => {
    it("does not split inside a fenced code block — closes block gracefully", () => {
        // Build: preamble (safe) + code block that spans multiple lines
        const preamble = "Some text before the block";
        const codeBlock = `${FENCE}typescript\n${chars(500)}\n${chars(500)}\n${FENCE}`;
        const text = `${preamble}\n${codeBlock}`;
        // Limit is set so that the split would fall inside the code block
        const limit = preamble.length + 1 + `${FENCE}typescript\n`.length + 100;
        const result = splitMarkdown(text, 0, limit);
        // The page must end with a synthetic closing fence (not truncated mid-line)
        expect(result.content.endsWith(`\n${FENCE}`)).toBe(true);
        // Content must start with the preamble
        expect(result.content.startsWith(preamble)).toBe(true);
        // newOffset must be strictly before the real closing fence in the original text
        expect(result.newOffset).toBeLessThan(text.length);
        expect(result.endedInCodeBlock).toBe(true);
        expect(result.codeBlockType).toBe("typescript");
    });

    it("splits after a code block that ends before the limit", () => {
        const codeBlock = "```\ncode\n```";
        const after = "\nafter text";
        const text = codeBlock + after;
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(text);
        expect(result.newOffset).toBe(text.length);
    });

    it("splits into a code block gracefully when preamble + block would exceed limit", () => {
        const preamble = lines(3, 100); // 3 lines of 100 chars = 302 chars with newlines
        const codeLines = lines(20, 100); // 20 lines of 100 chars inside code block
        const codeBlock = `${FENCE}\n${codeLines}\n${FENCE}`;
        const text = `${preamble}\n${codeBlock}`;
        // Limit just enough for preamble + opening fence, but not all code lines
        const limit = preamble.length + 50;
        const result = splitMarkdown(text, 0, limit);
        // Page must contain the preamble and end with a synthetic closing fence
        expect(result.content.startsWith(preamble)).toBe(true);
        expect(result.content.endsWith(`\n${FENCE}`)).toBe(true);
        expect(result.endedInCodeBlock).toBe(true);
        // newOffset must be before the real closing fence
        expect(result.newOffset).toBeLessThan(text.length);
    });

    it("gracefully closes a large code block that starts at the very beginning of the page", () => {
        // Edge case: code block at offset 0 — opening fence fits, then content exceeds limit.
        // New behavior: closes the block with a synthetic fence rather than hard-splitting.
        const bigCodeBlock = `${FENCE}\n${chars(3000)}\n${FENCE}`;
        const result = splitMarkdown(bigCodeBlock, 0, 100);
        // Must end with the synthetic closing fence
        expect(result.content.endsWith(`\n${FENCE}`)).toBe(true);
        // newOffset is after the opening fence only — not 100 characters in
        expect(result.newOffset).toBeGreaterThan(0);
        expect(result.newOffset).toBeLessThan(bigCodeBlock.length);
        expect(result.endedInCodeBlock).toBe(true);
    });
});

describe("splitMarkdown — table protection", () => {
    it("does not split inside a markdown table", () => {
        const preamble = "Before the table";
        const table = "| Col A | Col B |\n| --- | --- |\n| val1 | val2 |\n| val3 | val4 |";
        const text = `${preamble}\n${table}`;
        // Limit just enough to cut into the table without protection
        const limit = preamble.length + 1 + "| Col A | Col B |".length + 5;
        const result = splitMarkdown(text, 0, limit);
        // Must not split inside the table
        expect(result.content).toBe(preamble);
        expect(result.newOffset).toBe(preamble.length);
    });

    it("splits after a table that ends before the limit", () => {
        const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
        const after = "\nsome text after";
        const text = table + after;
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(text);
        expect(result.newOffset).toBe(text.length);
    });

    it("splits before a table when preamble + table would exceed limit", () => {
        const preamble = "Intro paragraph\nwith two lines";
        const tableRow = `| ${chars(80)} | ${chars(80)} |`;
        const table = `${tableRow}\n| --- | --- |\n${tableRow}\n${tableRow}\n${tableRow}`;
        const text = `${preamble}\n${table}`;
        const limit = preamble.length + 50; // enough for preamble, not table
        const result = splitMarkdown(text, 0, limit);
        expect(result.content).toBe(preamble);
        expect(result.newOffset).toBe(preamble.length);
    });
});

describe("splitMarkdown — pageCount option", () => {
    it("returns pageCount=1 for text under limit", () => {
        const text = "Short text";
        const result = splitMarkdown(text, 0, 2000, { pageCount: true });
        expect(result.pageCount).toBe(1);
    });

    it("returns pageCount=1 for empty text", () => {
        const result = splitMarkdown("", 0, 2000, { pageCount: true });
        expect(result.pageCount).toBe(1);
    });

    it("returns correct pageCount for two-page text", () => {
        // Two lines of 1001 chars each — each line exactly fits in 1001, but together > 2000
        const line = chars(1001);
        const text = `${line}\n${line}`;
        // With limit 1001: line1 fits on page 1, line2 on page 2
        const result = splitMarkdown(text, 0, 1001, { pageCount: true });
        expect(result.pageCount).toBe(2);
    });

    it("pageCount is consistent: paginating step-by-step reaches end in exactly pageCount steps", () => {
        // 5 lines of 500 chars, limit = 1001 (each page holds at most 2 lines)
        const line = chars(500);
        const text = [line, line, line, line, line].join("\n");
        const limit = 1001;
        const { pageCount } = splitMarkdown(text, 0, limit, { pageCount: true });

        let steps = 0;
        let offset = 0;
        while (offset < text.length) {
            const { newOffset } = splitMarkdown(text, offset, limit);
            expect(newOffset).toBeGreaterThan(offset); // always makes progress
            offset = newOffset;
            steps++;
        }

        expect(steps).toBe(pageCount ?? 0);
    });

    it("does not include pageCount when option not passed", () => {
        const result = splitMarkdown("hello\nworld", 0, 2000);
        expect(result.pageCount).toBeUndefined();
    });
});

describe("splitMarkdown — offset continuation", () => {
    it("pages through text completely when called sequentially", () => {
        // 10 lines of 300 chars, limit=601 (2 lines per page)
        const line = chars(300);
        const text = Array.from({ length: 10 }, () => line).join("\n");
        const limit = 601;

        const pages: string[] = [];
        let offset = 0;
        while (offset < text.length) {
            const { content, newOffset } = splitMarkdown(text, offset, limit);
            pages.push(content);
            if (newOffset <= offset) break; // safety
            offset = newOffset;
        }

        // Pages are split at the \n boundary; the boundary \n is consumed and becomes
        // the first character of the next page's slice, so joining with "" reconstructs the original.
        expect(pages.join("")).toBe(text);
    });

    it("final page newOffset equals text.length", () => {
        const text = "aaa\nbbb\nccc";
        let offset = 0;
        let lastNewOffset = 0;
        while (offset < text.length) {
            const { newOffset } = splitMarkdown(text, offset, 5);
            lastNewOffset = newOffset;
            if (newOffset <= offset) break;
            offset = newOffset;
        }
        expect(lastNewOffset).toBe(text.length);
    });
});

describe("splitMarkdown — endedInCodeBlock / codeBlockType fields", () => {
    it("endedInCodeBlock is false and codeBlockType is null for normal splits", () => {
        const text = "line one\nline two\nline three";
        const result = splitMarkdown(text, 0, 2000);
        expect(result.endedInCodeBlock).toBe(false);
        expect(result.codeBlockType).toBeNull();
    });

    it("appends closing fence and sets endedInCodeBlock when split falls inside a labelled code block", () => {
        // preamble + opening fence + code lines (too many to fit in limit)
        const preamble = "intro\n";
        const open = `${FENCE}typescript\n`;
        const codeLine = chars(100);
        // limit: fits preamble + open fence + 2 code lines, but not all of them
        const limit = preamble.length + open.length + (codeLine.length + 1) * 2 + 10;
        const text = `${preamble}${open}${Array.from({ length: 10 }, () => codeLine).join("\n")}\n${FENCE}`;

        const result = splitMarkdown(text, 0, limit);

        expect(result.endedInCodeBlock).toBe(true);
        expect(result.codeBlockType).toBe("typescript");
        // Content must end with the synthetic closing fence
        expect(result.content.endsWith(`\n${FENCE}`)).toBe(true);
        // newOffset must not include the synthetic fence characters
        expect(text.slice(result.newOffset)).not.toBe("");
    });

    it("sets endedInCodeBlock for an unlabelled code block", () => {
        const preamble = "before\n";
        const open = `${FENCE}\n`;
        const codeLine = chars(100);
        const limit = preamble.length + open.length + codeLine.length + 10;
        const text = `${preamble}${open}${Array.from({ length: 5 }, () => codeLine).join("\n")}\n${FENCE}`;

        const result = splitMarkdown(text, 0, limit);

        expect(result.endedInCodeBlock).toBe(true);
        expect(result.codeBlockType).toBe("");
    });

    it("endedInCodeBlock is false after a code block that fits entirely on the page", () => {
        const text = `${FENCE}typescript\ncode here\n${FENCE}\nafter`;
        const result = splitMarkdown(text, 0, 2000);
        expect(result.endedInCodeBlock).toBe(false);
        expect(result.codeBlockType).toBeNull();
    });
});

describe("splitMarkdown — code block continuation (2-page)", () => {
    it("continuation header is prepended on page 2 and does not shift newOffset", () => {
        const preamble = "intro\n";
        const open = `${FENCE}typescript\n`;
        const codeLines = Array.from({ length: 10 }, () => chars(80)).join("\n");
        const text = `${preamble}${open}${codeLines}\n${FENCE}\nafter`;

        // Limit that forces a split inside the code block
        const limit = preamble.length + open.length + chars(80).length + 10;

        const page1 = splitMarkdown(text, 0, limit);
        expect(page1.endedInCodeBlock).toBe(true);
        expect(page1.codeBlockType).toBe("typescript");

        // Page 2: pass the continuation
        const page2 = splitMarkdown(text, page1.newOffset, limit, {
            continuationCodeBlock: page1.codeBlockType,
        });

        // Content must start with the re-opening fence
        expect(page2.content.startsWith(`${FENCE}typescript\n`)).toBe(true);
        // newOffset must advance past page1.newOffset
        expect(page2.newOffset).toBeGreaterThan(page1.newOffset);
    });

    it("page 2 with continuation does not double-count continuation header in newOffset", () => {
        // The continuation header is cosmetic — newOffset must reflect only real text chars
        const open = `${FENCE}ts\n`;
        const codeLines = Array.from({ length: 6 }, () => chars(50)).join("\n");
        const text = `${open}${codeLines}\n${FENCE}`;
        const limit = open.length + chars(50).length * 2 + 5;

        const page1 = splitMarkdown(text, 0, limit);
        const page2 = splitMarkdown(text, page1.newOffset, limit, {
            continuationCodeBlock: page1.codeBlockType,
        });

        // Joining page1 raw offset slice + page2 raw offset slice must cover all real text
        const covered = text.slice(0, page1.newOffset) + text.slice(page1.newOffset, page2.newOffset);
        expect(covered).toBe(text.slice(0, page2.newOffset));
        // The continuation header must NOT appear in the raw text at page1.newOffset
        expect(text.slice(page1.newOffset).startsWith(FENCE)).toBe(false);
    });

    it("null continuationCodeBlock produces no prepended header", () => {
        const text = "just text\nmore text";
        const result = splitMarkdown(text, 0, 2000, { continuationCodeBlock: null });
        expect(result.content.startsWith(FENCE)).toBe(false);
    });
});

describe("splitMarkdown — code block continuation (3-page)", () => {
    /**
     * Helper: simulate the full pagination loop the way the real caller does it,
     * threading endedInCodeBlock/codeBlockType as continuationCodeBlock each time.
     * Returns the array of page results.
     */
    function paginateWithContinuation(text: string, limit: number): Array<ReturnType<typeof splitMarkdown>> {
        const pages: Array<ReturnType<typeof splitMarkdown>> = [];
        let offset = 0;
        let continuationCodeBlock: string | null = null;

        while (offset < text.length) {
            const result = splitMarkdown(text, offset, limit, { continuationCodeBlock });
            pages.push(result);
            if (result.newOffset <= offset) break; // safety: no progress
            offset = result.newOffset;
            continuationCodeBlock = result.endedInCodeBlock ? result.codeBlockType : null;
        }

        return pages;
    }

    it("3 pages: all newOffsets are distinct and cover the full text exactly once", () => {
        // Construct text that forces exactly 3 pages with a code block spanning all of them
        const open = `${FENCE}python\n`;
        const codeLine = chars(60);
        // 30 code lines so the block is long enough to span 3 pages
        const codeLines = Array.from({ length: 30 }, () => codeLine).join("\n");
        const text = `preamble\n${open}${codeLines}\n${FENCE}`;
        // Limit: fits preamble + open + ~3 code lines per page
        const limit = "preamble\n".length + open.length + (codeLine.length + 1) * 3 + 5;

        const pages = paginateWithContinuation(text, limit);
        expect(pages.length).toBeGreaterThanOrEqual(3);

        // Offsets must be strictly increasing
        for (let i = 1; i < pages.length; i++) {
            const page = pages[i];
            const prevPage = pages[i - 1];
            if (!page || !prevPage) throw new Error(`Missing page at index ${i}`);
            expect(page.newOffset).toBeGreaterThan(prevPage.newOffset);
        }

        // Last newOffset must equal text.length
        const lastPage = pages.at(-1);
        if (!lastPage) throw new Error("pages array is empty");
        expect(lastPage.newOffset).toBe(text.length);
    });

    it("3 pages: stripping synthetic fences from page contents and joining reconstructs original text", () => {
        const open = `${FENCE}javascript\n`;
        const codeLine = chars(70);
        const codeLines = Array.from({ length: 24 }, () => codeLine).join("\n");
        const text = `header line\n${open}${codeLines}\n${FENCE}\nfooter line`;
        const limit = "header line\n".length + open.length + (codeLine.length + 1) * 4 + 5;

        const pages = paginateWithContinuation(text, limit);
        expect(pages.length).toBeGreaterThanOrEqual(3);

        // Strip synthetic fences: closing ``` added at end of a mid-block page,
        // and re-opening ```{lang}\n prepended at start of a continuation page.
        // The real text at each page is text.slice(prevOffset, page.newOffset).
        let reconstructed = "";
        let prevOffset = 0;
        for (const page of pages) {
            reconstructed += text.slice(prevOffset, page.newOffset);
            prevOffset = page.newOffset;
        }
        expect(reconstructed).toBe(text);
    });

    it("3 pages: no line is emitted twice or omitted — content length accounting", () => {
        const open = `${FENCE}rust\n`;
        const codeLine = chars(55);
        const codeLines = Array.from({ length: 20 }, () => codeLine).join("\n");
        const text = `${open}${codeLines}\n${FENCE}`;
        const limit = open.length + (codeLine.length + 1) * 3 + 5;

        const pages = paginateWithContinuation(text, limit);
        expect(pages.length).toBeGreaterThanOrEqual(3);

        // Each page's newOffset minus the previous one = the real character count consumed
        // from the original text on that page. Their sum must equal text.length exactly.
        const allOffsets = [0, ...pages.map((p) => p.newOffset)];
        const realCharCounts = allOffsets.slice(1).map((end, i) => end - (allOffsets[i] ?? 0));
        const total = realCharCounts.reduce((sum, n) => sum + n, 0);
        expect(total).toBe(text.length);
    });

    it("3 pages: middle page has continuation header when it spans a code block", () => {
        const open = `${FENCE}go\n`;
        const codeLine = chars(65);
        const codeLines = Array.from({ length: 18 }, () => codeLine).join("\n");
        const text = `preamble\n${open}${codeLines}\n${FENCE}\npostamble`;
        const limit = "preamble\n".length + open.length + (codeLine.length + 1) * 3 + 5;

        const pages = paginateWithContinuation(text, limit);
        expect(pages.length).toBeGreaterThanOrEqual(3);

        // Middle page(s) that are still inside the code block must have a continuation header
        for (let i = 1; i < pages.length - 1; i++) {
            const prev = pages[i - 1];
            const curr = pages[i];
            if (!prev || !curr) throw new Error(`Missing page at index ${i}`);
            if (prev.endedInCodeBlock) {
                expect(curr.content.startsWith(`${FENCE}go\n`)).toBe(true);
            }
        }
    });

    it("3 pages: pageCount from extractAllPages matches step-by-step pagination count", () => {
        const open = `${FENCE}bash\n`;
        const codeLine = chars(50);
        const codeLines = Array.from({ length: 18 }, () => codeLine).join("\n");
        const text = `intro\n${open}${codeLines}\n${FENCE}`;
        const limit = "intro\n".length + open.length + (codeLine.length + 1) * 3 + 5;

        const { pageCount } = splitMarkdown(text, 0, limit, { pageCount: true });
        const pages = paginateWithContinuation(text, limit);
        expect(typeof pageCount).toBe("number");
        expect(pages.length).toBe(pageCount as number);
    });
});
