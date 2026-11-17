/**
 * Brute-force fuzz run for the markdown splitter.
 *
 * Paginates the fuzz fixture at every page limit in a range, with LF and CRLF line
 * endings and several first-page limits, and checks every page against the
 * invariants in tests/helpers/markdownSplitInvariants.ts. It also verifies that a
 * `pageCount` lookup at each page offset returns the same page as stepping there.
 *
 * Too slow for the unit test suite (about 20 seconds for the full range), so run it
 * by hand after changing the splitter:
 *
 *   bun scripts/dev/markdownSplitterTest.ts [maxLimit=2000] [minLimit=1]
 *
 * Exits with code 1 when any pagination violates an invariant.
 */

import { file } from "bun";
import { splitMarkdown } from "../../src/application/formatters/markdownSplitter.ts";
import { checkPagination } from "../../tests/helpers/markdownSplitInvariants.ts";

/** Paginations with more pages than this skip the quadratic `pageCount` lookup check. */
const MAX_PAGES_FOR_LOOKUP_CHECK = 40;

/** Failing paginations printed in full before the output is truncated. */
const MAX_REPORTED_FAILURES = 20;

const FIXTURE_URL = new URL("../../tests/unit/discord/data/markdownSplitterTest-fuzz.md", import.meta.url);

/** First-page limits to try for a given limit: equal, slightly reduced, and halved. */
function firstPageLimits(limit: number): Set<number> {
    return new Set([limit, Math.max(1, limit - 37), Math.max(1, Math.floor(limit / 2))]);
}

/** Checks one pagination and returns its invariant violations. */
function violationsFor(text: string, limit: number, firstPageLimit: number): string[] {
    const report = checkPagination(text, limit, firstPageLimit);
    const violations = [...report.violations];
    if (report.pages.length > MAX_PAGES_FOR_LOOKUP_CHECK) return violations;

    for (const page of report.pages) {
        const lookedUp = splitMarkdown(text, page.offset, limit, { pageCount: true, firstPageLimit });
        if (lookedUp.content !== page.content || lookedUp.newOffset !== page.newOffset) {
            violations.push(`limit ${limit}/${firstPageLimit}: pageCount lookup differs at offset ${page.offset}`);
        }
    }
    return violations;
}

const maxLimit = Number(process.argv[2] ?? 2000);
const minLimit = Number(process.argv[3] ?? 1);
if (!Number.isInteger(maxLimit) || !Number.isInteger(minLimit) || minLimit < 1 || maxLimit < minLimit) {
    console.error("Usage: bun scripts/dev/markdownSplitterTest.ts [maxLimit=2000] [minLimit=1]");
    process.exit(2);
}

const lf = await file(FIXTURE_URL).text();
const variants = { LF: lf, CRLF: lf.replaceAll("\n", "\r\n") };

const startedAt = performance.now();
let paginations = 0;
const failures = new Map<string, string[]>();

for (const [lineEnding, text] of Object.entries(variants)) {
    for (let limit = minLimit; limit <= maxLimit; limit++) {
        for (const firstPageLimit of firstPageLimits(limit)) {
            paginations++;
            const violations = violationsFor(text, limit, firstPageLimit);
            if (violations.length > 0) failures.set(`${lineEnding} ${limit}/${firstPageLimit}`, violations);
        }
    }
}

const elapsedMs = Math.round(performance.now() - startedAt);
console.log(
    `${paginations} paginations of a ${lf.length}-char fixture, limits ${minLimit}..${maxLimit}, in ${elapsedMs}ms: ${failures.size} failing`,
);

for (const [key, violations] of [...failures].slice(0, MAX_REPORTED_FAILURES)) {
    console.log(`\n${key}`);
    for (const violation of violations.slice(0, 5)) console.log(`  ${violation}`);
    if (violations.length > 5) console.log(`  … ${violations.length - 5} more`);
}
if (failures.size > MAX_REPORTED_FAILURES) {
    console.log(`\n… ${failures.size - MAX_REPORTED_FAILURES} more failing paginations`);
}

process.exit(failures.size > 0 ? 1 : 0);
