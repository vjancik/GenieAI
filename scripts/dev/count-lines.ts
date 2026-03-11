/**
 * count-lines.ts — counts source lines of code across the project's *.ts files.
 *
 * Each line is classified as one of:
 *   code    — non-blank, non-comment
 *   comment — trimmed line starts with //, /*, or * (covers JSDoc/block comment lines)
 *   blank   — empty or whitespace-only
 *
 * Source files: all *.ts under src/ and tests/, excluding *.test.ts
 * Test files:   all *.test.ts under src/ and tests/
 *
 * Run with: bun scripts/dev/count-lines.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Bash equivalents (approximate, requires GNU grep + awk):
 *
 *   # Source code lines (non-blank, non-comment, excl. *.test.ts):
 *   find src tests -name '*.ts' ! -name '*.test.ts' -print0 \
 *     | xargs -0 grep -Evc '^\s*(//|/?[*]|$)' 2>/dev/null \
 *     | awk -F: '{s+=$NF} END{print s}'
 *
 *   # Source total lines:
 *   find src tests -name '*.ts' ! -name '*.test.ts' -print0 \
 *     | xargs -0 cat | wc -l
 *
 *   # Source comment lines:
 *   find src tests -name '*.ts' ! -name '*.test.ts' -print0 \
 *     | xargs -0 grep -Ec '^\s*(//|/?[*])' 2>/dev/null \
 *     | awk -F: '{s+=$NF} END{print s}'
 *
 *   # Test file code lines:
 *   find src tests -name '*.test.ts' -print0 \
 *     | xargs -0 grep -Evc '^\s*(//|/?[*]|$)' 2>/dev/null \
 *     | awk -F: '{s+=$NF} END{print s}'
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface LineStats {
    total: number;
    code: number;
    comment: number;
    blank: number;
}

interface CategoryStats extends LineStats {
    files: number;
}

/** Project root is 2 levels up from scripts/dev/. */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SEARCH_DIRS = ["src", "tests"];

/** Recursively collects *.ts file paths under a directory. */
function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * Classifies each line as code, comment, or blank.
 *
 * Comment detection is intentionally simplified: a trimmed line that starts
 * with //, /*, or * is counted as a comment. This accurately captures
 * JSDoc blocks and single-line comments without requiring bracket matching.
 */
function analyzeFile(filePath: string): LineStats {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    let code = 0,
        comment = 0,
        blank = 0;

    for (const line of lines) {
        const t = line.trim();
        if (t === "") {
            blank++;
        } else if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) {
            comment++;
        } else {
            code++;
        }
    }

    return { total: lines.length, code, comment, blank };
}

function sumStats(filePaths: string[]): CategoryStats {
    return filePaths.reduce(
        (acc, f) => {
            const s = analyzeFile(f);
            return {
                files: acc.files + 1,
                total: acc.total + s.total,
                code: acc.code + s.code,
                comment: acc.comment + s.comment,
                blank: acc.blank + s.blank,
            };
        },
        { files: 0, total: 0, code: 0, comment: 0, blank: 0 },
    );
}

// ── Collect files ────────────────────────────────────────────────────────────

const allFiles = SEARCH_DIRS.flatMap((d) => collectTsFiles(join(PROJECT_ROOT, d)));
const sourceFiles = allFiles.filter((f) => !f.endsWith(".test.ts"));
const testFiles = allFiles.filter((f) => f.endsWith(".test.ts"));

const src = sumStats(sourceFiles);
const tst = sumStats(testFiles);
const tot: CategoryStats = {
    files: src.files + tst.files,
    total: src.total + tst.total,
    code: src.code + tst.code,
    comment: src.comment + tst.comment,
    blank: src.blank + tst.blank,
};

// ── Print table ──────────────────────────────────────────────────────────────

const HEADERS = ["Category", "Files", "Total", "Code", "Comments", "Blank"];

const ROWS: [string, number, number, number, number, number][] = [
    ["Source", src.files, src.total, src.code, src.comment, src.blank],
    ["Tests", tst.files, tst.total, tst.code, tst.comment, tst.blank],
    ["Total", tot.files, tot.total, tot.code, tot.comment, tot.blank],
];

/** Formats a number with thousands separators. */
function n(x: number): string {
    return x.toLocaleString("en-US");
}

const strRows = ROWS.map((row) => row.map((cell, i) => (i === 0 ? String(cell) : n(cell as number))));

// Compute column widths from headers and data
const widths = HEADERS.map((h, i) => Math.max(h.length, ...strRows.map((r) => (r[i] ?? "").length)));

const sep = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;

const formatRow = (cells: string[]) =>
    `│${cells.map((c, i) => ` ${i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)} `).join("│")}│`;

const [srcRow, tstRow, totRow] = strRows;

console.log("\n  Code Statistics — GenieAIV2\n");
console.log(sep("┌", "┬", "┐"));
console.log(formatRow(HEADERS));
console.log(sep("├", "┼", "┤"));
if (srcRow) console.log(formatRow(srcRow)); // Source
if (tstRow) console.log(formatRow(tstRow)); // Tests
console.log(sep("├", "┼", "┤"));
if (totRow) console.log(formatRow(totRow)); // Total
console.log(sep("└", "┴", "┘"));
console.log();
