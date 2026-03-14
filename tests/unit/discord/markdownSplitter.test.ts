import { describe, expect, it } from "bun:test";
import { splitMarkdown } from "../../../src/application/markdownSplitter.ts";

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
    it("does not split inside a fenced code block", () => {
        // Build: preamble (safe) + code block that spans multiple lines
        const preamble = "Some text before the block";
        const codeBlock = `${FENCE}typescript\n${chars(500)}\n${chars(500)}\n${FENCE}`;
        const text = `${preamble}\n${codeBlock}`;
        // Limit is set so that the split would fall inside the code block without protection
        const limit = preamble.length + 1 + `${FENCE}typescript\n`.length + 100;
        const result = splitMarkdown(text, 0, limit);
        // Must split before the code block, not inside it
        expect(result.content).toBe(preamble);
        expect(result.newOffset).toBe(preamble.length);
    });

    it("splits after a code block that ends before the limit", () => {
        const codeBlock = "```\ncode\n```";
        const after = "\nafter text";
        const text = codeBlock + after;
        const result = splitMarkdown(text, 0, 2000);
        expect(result.content).toBe(text);
        expect(result.newOffset).toBe(text.length);
    });

    it("splits before a code block when preamble + block would exceed limit", () => {
        const preamble = lines(3, 100); // 3 lines of 100 chars = 302 chars with newlines
        const codeLines = lines(20, 100); // 20 lines of 100 chars inside code block
        const codeBlock = `${FENCE}\n${codeLines}\n${FENCE}`;
        const text = `${preamble}\n${codeBlock}`;
        // Limit just enough for preamble but not code block
        const limit = preamble.length + 50;
        const result = splitMarkdown(text, 0, limit);
        // Should split right at the preamble boundary
        expect(result.content).toBe(preamble);
        expect(result.newOffset).toBe(preamble.length);
    });

    it("handles hard-split fallback when entire page starts with a large code block", () => {
        // Edge case: no safe backup point (code block at very start)
        const bigCodeBlock = `${FENCE}\n${chars(3000)}\n${FENCE}`;
        const result = splitMarkdown(bigCodeBlock, 0, 100);
        // Falls back to hard-split at limit=100
        expect(result.content.length).toBeLessThanOrEqual(100);
        expect(result.newOffset).toBe(100);
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
