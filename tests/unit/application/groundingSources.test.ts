import { describe, expect, it } from "bun:test";
import {
    extractWebGroundingChunks,
    formatGroundingSources,
    type WebSource,
} from "../../../src/application/formatters/groundingSources.ts";

// ---------------------------------------------------------------------------
// extractWebGroundingChunks
// ---------------------------------------------------------------------------

describe("extractWebGroundingChunks", () => {
    it("returns empty array for null / undefined input", () => {
        expect(extractWebGroundingChunks(null)).toEqual([]);
        expect(extractWebGroundingChunks(undefined)).toEqual([]);
    });

    it("returns empty array when no groundingMetadata present", () => {
        expect(extractWebGroundingChunks({ foo: "bar" })).toEqual([]);
    });

    it("returns empty array when groundingChunks is empty", () => {
        expect(
            extractWebGroundingChunks({
                groundingMetadata: { groundingChunks: [] },
            }),
        ).toEqual([]);
    });

    it("extracts web chunks with uri and title", () => {
        const result = extractWebGroundingChunks({
            groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
            },
        });
        expect(result).toEqual([{ uri: "https://example.com", title: "Example" }]);
    });

    it("ignores non-web chunks (e.g. retrievedContext) without failing", () => {
        const result = extractWebGroundingChunks({
            groundingMetadata: {
                groundingChunks: [
                    { retrievedContext: { uri: "gs://bucket/doc", title: "Internal" } },
                    { web: { uri: "https://example.com", title: "Web" } },
                ],
            },
        });
        expect(result).toEqual([{ uri: "https://example.com", title: "Web" }]);
    });

    it("handles mixed chunks with some lacking web property", () => {
        const result = extractWebGroundingChunks({
            groundingMetadata: {
                groundingChunks: [
                    {},
                    { web: { uri: "https://a.com", title: "A" } },
                    { web: { uri: "https://b.com", title: "B" } },
                ],
            },
        });
        expect(result).toEqual([
            { uri: "https://a.com", title: "A" },
            { uri: "https://b.com", title: "B" },
        ]);
    });

    it("tolerates extra unknown properties on the chunk", () => {
        const result = extractWebGroundingChunks({
            groundingMetadata: {
                groundingChunks: [
                    {
                        web: { uri: "https://example.com", title: "X", someExtra: true },
                        unknownField: 42,
                    },
                ],
                otherMetadata: "ignored",
            },
        });
        expect(result).toEqual([{ uri: "https://example.com", title: "X" }]);
    });
});

// ---------------------------------------------------------------------------
// formatGroundingSources
// ---------------------------------------------------------------------------

describe("formatGroundingSources", () => {
    const src = (title: string, url: string): WebSource => ({ title, url });

    it("returns null for empty sources array", () => {
        expect(formatGroundingSources([])).toBeNull();
    });

    it("formats a single source", () => {
        const result = formatGroundingSources([src("Example", "https://example.com")]);
        expect(result).toBe("*Sources: [Example](<https://example.com>)*");
    });

    it("formats multiple sources separated by commas", () => {
        const result = formatGroundingSources([src("Alpha", "https://alpha.com"), src("Beta", "https://beta.com")]);
        expect(result).toBe("*Sources: [Alpha](<https://alpha.com>), [Beta](<https://beta.com>)*");
    });

    it("respects maxLength — excludes source that would exceed it", () => {
        // "*Sources: *" = 11 chars (prefix 10 + suffix 1)
        // "[A](<https://a.com>)" = 20 chars → total = 11 + 20 = 31
        // "[B](<https://b.com>)" = 20 chars + 2 separator = 22 → 31 + 22 = 53
        // Set maxLength to 32 → only first source fits
        const result = formatGroundingSources([src("A", "https://a.com"), src("B", "https://b.com")], 32);
        expect(result).toBe("*Sources: [A](<https://a.com>)*");
        expect(result?.length).toBeLessThanOrEqual(32);
    });

    it("returns null when even one source exceeds maxLength", () => {
        // "*Sources: *" = 11 chars; any source needs to fit within e.g. 5 chars
        const result = formatGroundingSources([src("A", "https://a.com")], 5);
        expect(result).toBeNull();
    });

    it("exact boundary: source fits exactly at maxLength", () => {
        const single = "*Sources: [A](<https://a.com>)*";
        // single.length = 31
        const result = formatGroundingSources([src("A", "https://a.com")], single.length);
        expect(result).toBe(single);
        expect(result?.length).toBe(single.length);
    });

    it("exact boundary: source does not fit when maxLength is one less", () => {
        const single = "*Sources: [A](<https://a.com>)*";
        const result = formatGroundingSources([src("A", "https://a.com")], single.length - 1);
        expect(result).toBeNull();
    });

    it("includes as many sources as fit within maxLength (parametrized)", () => {
        // Build sources with known, equal sizes and verify count
        const sources: WebSource[] = [
            src("S1", "https://s1.com"),
            src("S2", "https://s2.com"),
            src("S3", "https://s3.com"),
            src("S4", "https://s4.com"),
        ];

        // Full result (no limit beyond 2000)
        const full = formatGroundingSources(sources);
        expect(full?.length).toBeLessThanOrEqual(2000);

        // Constrain to exactly fit the first 2 sources
        const twoSources = "*Sources: [S1](<https://s1.com>), [S2](<https://s2.com>)*";
        const result = formatGroundingSources(sources, twoSources.length);
        expect(result).toBe(twoSources);
    });

    it("default maxLength allows 2000 characters", () => {
        // A single source with a very long URL up to ~1980 chars is fine
        const longUrl = `https://${"x".repeat(1960)}.com`;
        const result = formatGroundingSources([src("Long", longUrl)]);
        // Output: "*Sources: [Long](<https://xxxx...x.com>)*"
        // len = 10 (prefix) + 1 (suffix) + "[Long](<".length=8 + longUrl.length + ">)".length=2
        // = 10 + 1 + 8 + longUrl.length + 2 = 21 + longUrl.length
        const expected = `*Sources: [Long](<${longUrl}>)*`;
        expect(result).toBe(expected);
        expect(result?.length).toBeLessThanOrEqual(2000);
    });
});
