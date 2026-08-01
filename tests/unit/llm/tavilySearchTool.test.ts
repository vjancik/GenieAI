import { describe, expect, it, mock } from "bun:test";
import type { Logger } from "../../../src/application/types/Logger.ts";
import {
    safeParseTavilyResponse,
    tavilyResultsToGroundingChunks,
} from "../../../src/infrastructure/llm/tools/tavilySearchTool.ts";

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
    const makeLogger = () => ({ warn: mock(() => {}) }) as unknown as Logger;
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
