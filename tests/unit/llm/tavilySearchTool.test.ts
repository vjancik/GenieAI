import { describe, expect, it, mock } from "bun:test";
import type { Logger } from "../../../src/application/types/Logger.ts";
import {
    dedupeGroundingChunks,
    extractTavilyResults,
    safeParseTavilyResponse,
    searchResultsToGroundingChunks,
    tavilyResultsToGroundingChunks,
} from "../../../src/infrastructure/llm/tools/tavilySearchTool.ts";

const makeLogger = () => ({ warn: mock(() => {}) }) as unknown as Logger;

describe("safeParseTavilyResponse", () => {
    it("parses a pre-parsed object directly", () => {
        const obj = { results: [{ url: "https://example.com", title: "Example", content: "text" }] };

        const { objResponse, parsed } = safeParseTavilyResponse(obj);

        expect(objResponse).toBe(obj);
        expect(parsed.success).toBe(true);
    });

    it("JSON.parses a string input before validating", () => {
        const obj = { results: [{ url: "https://example.com", title: "Example", content: "text" }] };
        const raw = JSON.stringify(obj);

        const { objResponse, parsed } = safeParseTavilyResponse(raw);

        expect(objResponse).toEqual(obj);
        expect(parsed.success).toBe(true);
    });

    it("returns parsed.success=false when results field is missing", () => {
        const { parsed } = safeParseTavilyResponse({ query: "test" });

        expect(parsed.success).toBe(false);
    });

    it("returns the raw objResponse even when parse fails", () => {
        const obj = { notResults: [] };
        const { objResponse, parsed } = safeParseTavilyResponse(obj);

        expect(objResponse).toBe(obj);
        expect(parsed.success).toBe(false);
    });
});

describe("tavilyResultsToGroundingChunks", () => {
    const result = (url: string) => ({ url, title: "Title", content: "text" });

    it("maps absolute http(s) URLs to grounding chunks titled with the hostname", () => {
        const chunks = tavilyResultsToGroundingChunks(
            [result("https://example.com/a/b?q=1"), result("http://docs.example.org/page")],
            makeLogger(),
        );

        expect(chunks).toEqual([
            { web: { uri: "https://example.com/a/b?q=1", title: "example.com" } },
            { web: { uri: "http://docs.example.org/page", title: "docs.example.org" } },
        ]);
    });

    it("strips a leading www. from the title but leaves the URI untouched", () => {
        const chunks = tavilyResultsToGroundingChunks([result("https://www.example.com/x")], makeLogger());

        expect(chunks).toEqual([{ web: { uri: "https://www.example.com/x", title: "example.com" } }]);
    });

    it("skips relative redirect paths instead of throwing", () => {
        const relative = "/goto?url=CAESWQHuR6pNl_5AyH4_9nfXRdqlkDSuImVKeTFfFesEYT-k_IjulGNwlSQ1kGrXdHRW";
        const logger = makeLogger();

        const chunks = tavilyResultsToGroundingChunks([result(relative), result("https://example.com")], logger);

        expect(chunks).toEqual([{ web: { uri: "https://example.com", title: "example.com" } }]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith({ skippedUrls: [relative] }, expect.any(String));
    });

    it("skips malformed and non-http(s) URLs", () => {
        const chunks = tavilyResultsToGroundingChunks(
            [result("not a url"), result("javascript:alert(1)"), result("ftp://example.com/file")],
            makeLogger(),
        );

        expect(chunks).toEqual([]);
    });

    it("does not log when every result URL is usable", () => {
        const logger = makeLogger();

        tavilyResultsToGroundingChunks([result("https://example.com")], logger);

        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("returns an empty array for no results", () => {
        expect(tavilyResultsToGroundingChunks([], makeLogger())).toEqual([]);
    });
});

describe("dedupeGroundingChunks", () => {
    const chunk = (uri: string, title = "Title") => ({ web: { uri, title } });

    it("keeps the first occurrence of each URL, in order", () => {
        const chunks = [chunk("https://a.com", "first"), chunk("https://b.com"), chunk("https://a.com", "second")];

        expect(dedupeGroundingChunks(chunks)).toEqual([chunk("https://a.com", "first"), chunk("https://b.com")]);
    });

    it("returns an empty array for no chunks", () => {
        expect(dedupeGroundingChunks([])).toEqual([]);
    });
});

describe("extractTavilyResults", () => {
    it("returns the untouched results array of a valid response", () => {
        const results = [{ url: "https://example.com", title: "Example", content: "text", favicon: "kept" }];
        const logger = makeLogger();

        expect(extractTavilyResults({ results, query: "q" }, logger)).toBe(results);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("accepts a JSON string response", () => {
        const results = [{ url: "https://example.com", title: "Example", content: "text" }];

        expect(extractTavilyResults(JSON.stringify({ results }), makeLogger())).toEqual(results);
    });

    it("warns about and still forwards results that don't match the schema", () => {
        const results = [{ url: "https://example.com" }];
        const logger = makeLogger();

        expect(extractTavilyResults({ results }, logger)).toBe(results);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("forwards the whole response when it has no results array", () => {
        const response = { error: "quota exceeded" };
        const logger = makeLogger();

        expect(extractTavilyResults(response, logger)).toBe(response);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});

describe("searchResultsToGroundingChunks", () => {
    const result = (url: string) => ({ url, title: "t", content: "c" });

    it("combines the sources of several searches, listing a shared one once", () => {
        const chunks = searchResultsToGroundingChunks(
            [[result("https://shared.com")], [result("https://shared.com"), result("https://b.com")]],
            makeLogger(),
        );

        expect(chunks).toEqual([
            { web: { uri: "https://shared.com", title: "shared.com" } },
            { web: { uri: "https://b.com", title: "b.com" } },
        ]);
    });

    it("ignores result sets that don't match the schema", () => {
        const chunks = searchResultsToGroundingChunks(
            [null, { error: "quota exceeded" }, [result("https://a.com")]],
            makeLogger(),
        );

        expect(chunks).toEqual([{ web: { uri: "https://a.com", title: "a.com" } }]);
    });

    it("returns an empty list for a search without results", () => {
        expect(searchResultsToGroundingChunks([[]], makeLogger())).toEqual([]);
    });

    it("returns null when no result set matched the schema", () => {
        expect(searchResultsToGroundingChunks([null, "garbage"], makeLogger())).toBeNull();
        expect(searchResultsToGroundingChunks([], makeLogger())).toBeNull();
    });
});
