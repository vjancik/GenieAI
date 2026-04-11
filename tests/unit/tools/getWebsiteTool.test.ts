import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { makeMockResponse, spyFetch, spyFetchWith } from "../../helpers/fetchHelpers.ts";

const testLogger = pino({ level: "silent" });

describe("createGetWebsiteTool", () => {
    let fetchSpy: ReturnType<typeof spyFetch>;

    beforeEach(() => {
        fetchSpy = spyFetch(makeMockResponse());
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    test("fetches a URL and converts HTML to markdown", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com"] });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect((result[0] as { pageContents: string }).pageContents).toContain("Hello");
        expect((result[0] as { pageContents: string }).pageContents).toContain("World");
    });

    test("sends browser-like headers", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        await tool.invoke({ urls: ["https://example.com"] });

        const callHeaders = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>;
        expect(callHeaders?.["user-agent"]).toContain("Chrome");
    });

    test("deduplicates URLs before fetching", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com", "https://example.com"] });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
    });

    test("handles multiple distinct URLs", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetchWith((url) =>
            makeMockResponse({ body: `<html><body><p>Content from ${url}</p></body></html>` }),
        );

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com", "https://other.com"] });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect(result[1]).toMatchObject({ url: "https://other.com" });
    });

    test("returns error entry when a URL returns HTTP error", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeMockResponse({ ok: false, status: 404, body: "Not Found" }));

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://bad.example.com"] });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            url: "https://bad.example.com",
            error: expect.stringContaining("https://bad.example.com"),
        });
    });

    test("rejects non-text content types with an error entry", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeMockResponse({ contentType: "image/png" }));

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com/image.png"] });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            url: "https://example.com/image.png",
            error: expect.stringContaining("https://example.com/image.png"),
        });
    });

    test("returns plain text as-is for non-HTML text content types", async () => {
        const plainText = "line one\nline two\nline three";
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeMockResponse({ contentType: "text/plain", body: plainText }));

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com/data.txt"] });

        expect((result[0] as { pageContents: string }).pageContents).toContain(plainText);
    });

    test("co-locates error and success entries when one URL fails", async () => {
        fetchSpy.mockRestore();
        let callCount = 0;
        fetchSpy = spyFetchWith(() => {
            callCount++;
            if (callCount === 1) return makeMockResponse({ ok: false, status: 500, body: "Error" });
            return makeMockResponse({ body: "<html><body><p>Good content</p></body></html>" });
        });

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://bad.com", "https://good.com"] });

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ url: "https://bad.com", error: expect.any(String) });
        expect((result[1] as { pageContents: string }).pageContents).toContain("Good content");
    });
});
