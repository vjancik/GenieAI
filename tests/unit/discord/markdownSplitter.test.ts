import { beforeAll, describe, expect, it } from "bun:test";
import { file } from "bun";
import { splitMarkdown } from "../../../src/application/formatters/markdownSplitter.ts";
import { checkPagination } from "../../helpers/markdownSplitInvariants.ts";

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

    it("page 1 content length plus footer must be 2000 characters or fewer", () => {
        // Simulate the gateway: limit = MESSAGE_LENGTH_LIMIT - fallbackFooter.length
        const FALLBACK_FOOTER =
            "\n*This response was generated using a fallback model. If it's unsatisfactory you can try to Retry later to see if the primary model is available again.*";
        const result = splitMarkdown(PROD_CONTENT, 0, 2000 - FALLBACK_FOOTER.length, { pageCount: true });
        expect(result.content.length + FALLBACK_FOOTER.length).toBeLessThanOrEqual(2000);
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
            "newOffset": 1920,
            "pageCount": 2,
          }
        `);
    });
});

// ---------------------------------------------------------------------------
// Regression test: real payload from production error 2026-03-24
// The assembled first page (discordResponse split + fallbackFooter) exceeded
// 2000 chars because the splitter limit didn't account for the footer length.
// ---------------------------------------------------------------------------
describe("splitMarkdown — regression: fallback footer overhead (2026-03-24)", () => {
    const FALLBACK_FOOTER =
        "\n*This response was generated using a fallback model. If it's unsatisfactory you can try to Retry later to see if the primary model is available again.*";

    let content: string;

    beforeAll(async () => {
        content = await file(new URL("data/markdownSplitterTest-message2.md", import.meta.url)).text();
    });

    it("fixture content plus footer exceeds 2000 characters (confirms the bug is reproducible)", () => {
        expect(content.length + FALLBACK_FOOTER.length).toBeGreaterThan(2000);
    });

    it("page 1 content plus fallback footer must be 2000 characters or fewer", () => {
        const result = splitMarkdown(content, 0, 2000, {
            pageCount: true,
            firstPageLimit: 2000 - FALLBACK_FOOTER.length,
        });
        expect(result.content.length + FALLBACK_FOOTER.length).toBeLessThanOrEqual(2000);
    });

    it("splits into exactly 2 pages when footer overhead is accounted for via firstPageLimit", () => {
        const result = splitMarkdown(content, 0, 2000, {
            pageCount: true,
            firstPageLimit: 2000 - FALLBACK_FOOTER.length,
        });
        expect(result.pageCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// firstPageLimit: unit tests
// ---------------------------------------------------------------------------
describe("splitMarkdown — firstPageLimit", () => {
    it("page 1 content respects firstPageLimit, not the full limit", () => {
        // 5 lines of 400 chars = 2000 chars total; full limit would fit all on one page,
        // but firstPageLimit=800 forces a split after line 2.
        const text = Array.from({ length: 5 }, () => "x".repeat(400)).join("\n");
        const result = splitMarkdown(text, 0, 2000, { pageCount: true, firstPageLimit: 800 });
        expect(result.content.length).toBeLessThanOrEqual(800);
    });

    it("pageCount reflects the reduced first-page capacity", () => {
        // 3 lines of 400 chars = 1202 chars total — fits in one page at limit=2000,
        // but firstPageLimit=800 forces a split so pageCount should be 2.
        const text = Array.from({ length: 3 }, () => "x".repeat(400)).join("\n");
        const withFirstLimit = splitMarkdown(text, 0, 2000, { pageCount: true, firstPageLimit: 800 });
        const withoutFirstLimit = splitMarkdown(text, 0, 2000, { pageCount: true });
        expect(withoutFirstLimit.pageCount).toBe(1);
        expect(withFirstLimit.pageCount).toBe(2);
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

/**
 * Paginates `text` the way production does, asserts that every page satisfies the
 * splitter's invariants, and returns the page contents.
 */
function paginate(text: string, limit: number, firstPageLimit?: number): string[] {
    const report = checkPagination(text, limit, firstPageLimit);
    expect(report.violations).toEqual([]);
    return report.pages.map((page) => page.content);
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

    it("splits on a line boundary and consumes the line break", () => {
        const line1 = chars(1000);
        const line2 = chars(1000);
        const text = `${line1}\n${line2}\nz`;
        // line1 + \n + line2 is exactly 2001 chars; the third line no longer fits
        const result = splitMarkdown(text, 0, 2001);
        expect(result.content).toBe(`${line1}\n${line2}`);
        expect(result.newOffset).toBe(2002);
        expect(splitMarkdown(text, result.newOffset, 2001).content).toBe("z");
    });

    it("handles empty string", () => {
        const result = splitMarkdown("", 0, 2000);
        expect(result.content).toBe("");
        expect(result.newOffset).toBe(0);
    });

    it("continues correctly from a non-zero offset", () => {
        const text = "AAAA\nBBBB\nCCCC";
        const result = splitMarkdown(text, 5, 10);
        expect(result.content).toBe("BBBB\nCCCC");
        expect(result.newOffset).toBe(text.length);
    });

    it("resumes from an offset that points at a line break", () => {
        // Offsets stored by the previous splitter pointed at the newline before the next line
        const text = "AAAA\nBBBB";
        const result = splitMarkdown(text, 4, 10);
        expect(result.content.trim()).toBe("BBBB");
        expect(result.newOffset).toBe(text.length);
    });

    it("handles CRLF line endings", () => {
        expect(paginate("AAAA\r\nBBBB\r\nCCCC", 10)).toEqual(["AAAA\r\nBBBB", "CCCC"]);
    });

    it("single line exceeding limit is hard-split with trailing ellipsis", () => {
        // No newlines — falls back to a hard split; 1 char reserved for "…"
        const text = chars(3000);
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(`${chars(1999)}…`);
        expect(result.newOffset).toBe(1999);
    });

    it("does not cut a surrogate pair in half when hard-splitting", () => {
        const text = `${chars(8)}🚀${chars(20)}`;
        // A cut at 9 would fall between the two halves of the emoji
        const result = splitMarkdown(text, 0, 10);
        expect(result.content).toBe(`${chars(8)}…`);
        expect(result.newOffset).toBe(8);
    });

    it("consumes blank lines at a page boundary instead of opening the next page with them", () => {
        expect(paginate("aaaa\n\n  \n\nbbbb", 4)).toEqual(["aaaa", "bbbb"]);
    });

    it("does not produce a trailing page for blank lines at the end of the text", () => {
        const result = splitMarkdown("aaaa\n\n\n", 0, 4, { pageCount: true });
        expect(result.content).toBe("aaaa");
        expect(result.pageCount).toBe(1);
    });

    it("treats a limit below 1 as 1", () => {
        expect(splitMarkdown("abc", 0, 0).content).toBe("a");
    });
});

// ---------------------------------------------------------------------------
// Regression test: message1 fixture — single long line > 2000 chars
// The content is a 98-char header line, a blank line, then a 2103-char single
// line (all facts on one line). The splitter must hard-split that line mid-way
// and produce a non-empty page 2.
// ---------------------------------------------------------------------------
describe("splitMarkdown — regression: long single-line content (message1)", () => {
    let text: string;
    beforeAll(async () => {
        text = await file(new URL("data/markdownSplitterTest-message1.md", import.meta.url)).text();
    });

    it("splits into exactly 3 non-empty pages within the limit", () => {
        const pages = paginate(text, 2000);
        expect(pages).toHaveLength(3);
        for (const page of pages) expect(page.length).toBeGreaterThan(0);
    });

    it("page 2 ends with the ellipsis (hard-split mid-line)", () => {
        expect(paginate(text, 2000)[1]?.endsWith("…")).toBe(true);
    });
});

describe("splitMarkdown — code blocks", () => {
    it("keeps a block that fits on the page intact", () => {
        const text = `${FENCE}\ncode\n${FENCE}\nafter text`;
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(text);
        expect(result.endedInCodeBlock).toBe(false);
        expect(result.codeBlockType).toBeNull();
    });

    it("closes a block at the page boundary and re-opens it on the next page", () => {
        const text = `intro\n${FENCE}ts\na1\na2\na3\na4\n${FENCE}\noutro`;
        expect(paginate(text, 20)).toEqual([
            `intro\n${FENCE}ts\na1\n${FENCE}`,
            `${FENCE}ts\na2\na3\na4\n${FENCE}`,
            "outro",
        ]);
    });

    it("reports the open block's label, and an empty label for an unlabelled block", () => {
        const labelled = splitMarkdown(`${FENCE}typescript\n${lines(5, 10)}\n${FENCE}`, 0, 40);
        expect(labelled.endedInCodeBlock).toBe(true);
        expect(labelled.codeBlockType).toBe("typescript");

        const unlabelled = splitMarkdown(`${FENCE}\n${lines(5, 10)}\n${FENCE}`, 0, 40);
        expect(unlabelled.endedInCodeBlock).toBe(true);
        expect(unlabelled.codeBlockType).toBe("");
    });

    it("counts the re-opening header toward the limit and not toward the offset", () => {
        const text = `${FENCE}typescript\n${lines(40, 20)}\n${FENCE}`;
        const page1 = splitMarkdown(text, 0, 200);
        const page2 = splitMarkdown(text, page1.newOffset, 200, { continuationCodeBlock: page1.codeBlockType });
        expect(page2.content.startsWith(`${FENCE}typescript\n${chars(20)}\n`)).toBe(true);
        expect(page2.content.length).toBeLessThanOrEqual(200);
        // Every source character lands on exactly one page
        expect(paginate(text, 200).join("").replaceAll(FENCE, "").replaceAll("typescript", "")).toMatch(/^[x\n]+$/);
    });

    it("moves the block to the next page when not even one body line fits behind the text", () => {
        const block = `${FENCE}ts\n${chars(20)}\n${FENCE}`;
        // The opening fence would still fit on page 1, but an opener without a body is never left behind
        expect(paginate(`intro text\n${block}`, 30)).toEqual(["intro text", block]);
    });

    it("carries a body line over when the closing fence does not fit", () => {
        // The whole block is 12 chars; the closing fence is what overflows
        expect(paginate(`${FENCE}\nab\ncd\n${FENCE}`, 11)).toEqual([
            `${FENCE}\nab\n${FENCE}`,
            `${FENCE}\ncd\n${FENCE}`,
        ]);
    });

    it("cuts a body line longer than a page inside the fences", () => {
        const text = `${FENCE}js\n${chars(50)}\n${FENCE}`;
        const pages = paginate(text, 20);
        expect(pages[0]).toBe(`${FENCE}js\n${chars(9)}…\n${FENCE}`);
        expect(pages[1]).toBe(`${FENCE}js\n${chars(9)}…\n${FENCE}`);
        expect(pages.at(-1)?.endsWith(`\n${FENCE}`)).toBe(true);
    });

    it("closes a block the text ends in", () => {
        const text = `${FENCE}py\nprint(1)`;
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(`${text}\n${FENCE}`);
        expect(result.newOffset).toBe(text.length);
        expect(result.endedInCodeBlock).toBe(true);
        expect(result.codeBlockType).toBe("py");
    });

    it("splits an unterminated block so that its closing fence still fits", () => {
        // 14 chars of text plus the synthetic fence would be 18
        expect(paginate(`${FENCE}\nab\ncd\nefgh`, 16)).toEqual([
            `${FENCE}\nab\ncd\n${FENCE}`,
            `${FENCE}\nefgh\n${FENCE}`,
        ]);
    });

    it("does not treat a single-line fenced span as a block opener", () => {
        const text = `${FENCE}inline${FENCE}\n${lines(6, 10)}`;
        const report = checkPagination(text, 30);
        expect(report.violations).toEqual([]);
        expect(report.pages.length).toBeGreaterThan(1);
        for (const page of report.pages) expect(page.endedInCodeBlock).toBe(false);
    });

    it("recognizes an indented fence", () => {
        const result = splitMarkdown(`  ${FENCE}sh\n${lines(5, 10)}\n  ${FENCE}`, 0, 40);
        expect(result.codeBlockType).toBe("sh");
        expect(result.content.endsWith(`\n${FENCE}`)).toBe(true);
    });

    it("ignores table rows inside a code block", () => {
        const text = `${FENCE}\n| a |\n| b |\n| c |\n| d |\n${FENCE}`;
        expect(paginate(text, 20)).toEqual([`${FENCE}\n| a |\n| b |\n${FENCE}`, `${FENCE}\n| c |\n| d |\n${FENCE}`]);
    });
});

describe("splitMarkdown — tables", () => {
    const table = "| Col A | Col B |\n| --- | --- |\n| val1 | val2 |\n| val3 | val4 |";

    it("moves a table to the next page instead of splitting it", () => {
        const text = `Before the table\n${table}\nAfter`;
        // Enough room to cut into the table, not enough for all of it
        expect(paginate(text, table.length + 6)).toEqual(["Before the table", `${table}\nAfter`]);
    });

    it("keeps a table that fits on the page intact", () => {
        const text = `${table}\nsome text after`;
        expect(splitMarkdown(text, 0, 2000).content).toBe(text);
    });

    it("splits right after a table when the following text does not fit", () => {
        expect(paginate(`intro\n${table}\nsome text after`, table.length + 6)).toEqual([
            `intro\n${table}`,
            "some text after",
        ]);
    });

    it("splits a table longer than a page between rows", () => {
        const rows = Array.from({ length: 10 }, (_, i) => `| row ${i} |`);
        const pages = paginate(rows.join("\n"), 30);
        expect(pages).toEqual([
            rows.slice(0, 3).join("\n"),
            rows.slice(3, 6).join("\n"),
            rows.slice(6, 9).join("\n"),
            rows.slice(9).join("\n"),
        ]);
    });
});

describe("splitMarkdown — pageCount option", () => {
    it("returns pageCount=1 for text under limit", () => {
        expect(splitMarkdown("short text", 0, 2000, { pageCount: true }).pageCount).toBe(1);
    });

    it("returns pageCount=1 and empty content for empty text", () => {
        const result = splitMarkdown("", 0, 2000, { pageCount: true });
        expect(result.pageCount).toBe(1);
        expect(result.content).toBe("");
    });

    it("does not include pageCount when option not passed", () => {
        expect(splitMarkdown("some text", 0, 2000).pageCount).toBeUndefined();
    });

    it("matches the number of pages produced step by step", () => {
        const text = `${lines(10, 150)}\n${FENCE}ts\n${lines(30, 60)}\n${FENCE}\n${lines(10, 150)}`;
        const report = checkPagination(text, 500);
        expect(report.violations).toEqual([]);
        expect(report.pageCount).toBe(report.pages.length);
        expect(report.pages.length).toBeGreaterThan(5);
    });

    it("returns the page at the requested offset, re-opening header included", () => {
        const text = `${FENCE}ts\n${lines(30, 60)}\n${FENCE}`;
        const { pages, pageCount } = checkPagination(text, 500);
        for (const page of pages) {
            const lookedUp = splitMarkdown(text, page.offset, 500, { pageCount: true });
            expect(lookedUp.content).toBe(page.content);
            expect(lookedUp.newOffset).toBe(page.newOffset);
            expect(lookedUp.pageCount).toBe(pageCount);
        }
    });
});

// ---------------------------------------------------------------------------
// Invariant sweep over a fixture that packs every tricky construct into one text.
// The limits were picked from a brute-force run over 1..2000 so that together they
// hit every kind of page boundary (see tests/helpers/markdownSplitInvariants.ts).
// ---------------------------------------------------------------------------
describe("splitMarkdown — invariants on the fuzz fixture", () => {
    // Too small for fence markup: only size, progress and coverage can hold
    const DEGENERATE_LIMITS = [1, 2, 5, 13, 19, 20, 63];
    const BOUNDARY_LIMITS = [
        64, 66, 68, 69, 78, 81, 84, 87, 93, 99, 101, 115, 116, 118, 123, 147, 151, 189, 192, 195, 217, 224, 356,
    ];
    const REALISTIC_LIMITS = [500, 1000, 1847, 2000];

    let variants: Record<string, string>;
    beforeAll(async () => {
        const lf = await file(new URL("data/markdownSplitterTest-fuzz.md", import.meta.url)).text();
        variants = { LF: lf, CRLF: lf.replaceAll("\n", "\r\n") };
    });

    for (const lineEnding of ["LF", "CRLF"]) {
        for (const limit of [...DEGENERATE_LIMITS, ...BOUNDARY_LIMITS, ...REALISTIC_LIMITS]) {
            it(`holds at limit ${limit} (${lineEnding})`, () => {
                const text = variants[lineEnding] ?? "";
                expect(text.length).toBeGreaterThan(10_000);
                expect(checkPagination(text, limit).violations).toEqual([]);
                // A shorter first page, as when page 1 carries a reply prefix and footer
                expect(checkPagination(text, limit, Math.max(1, limit - 37)).violations).toEqual([]);
            });
        }
    }
});
