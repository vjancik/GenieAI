import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

const testLogger = pino({ level: "silent" });

function makeMockResponse(opts: { ok?: boolean; status?: number; body?: string; contentType?: string }) {
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        headers: { get: (key: string) => (key === "content-type" ? (opts.contentType ?? "text/html") : null) },
        text: async () => opts.body ?? "<html><body><h1>Hello</h1><p>World</p></body></html>",
    };
}

describe("createGetWebsiteTool", () => {
    beforeEach(() => {
        mockFetch = mock(async (_url: string, _opts?: unknown) => makeMockResponse({}));
        globalThis.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("fetches a URL and converts HTML to markdown", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com"] });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect((result[0] as { pageContents: string }).pageContents).toContain("Hello");
        expect((result[0] as { pageContents: string }).pageContents).toContain("World");
    });

    test("sends browser-like headers", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        await tool.invoke({ urls: ["https://example.com"] });

        const callHeaders = (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>;
        expect(callHeaders?.["User-Agent"]).toContain("Chrome");
    });

    test("deduplicates URLs before fetching", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com", "https://example.com"] });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
    });

    test("handles multiple distinct URLs", async () => {
        mockFetch = mock(async (url: string, _opts?: unknown) =>
            makeMockResponse({ body: `<html><body><p>Content from ${url}</p></body></html>` }),
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com", "https://other.com"] });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect(result[1]).toMatchObject({ url: "https://other.com" });
    });

    test("returns error entry when a URL returns HTTP error", async () => {
        mockFetch = mock(async (_url: string, _opts?: unknown) =>
            makeMockResponse({ ok: false, status: 404, body: "Not Found" }),
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://bad.example.com"] });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ url: "https://bad.example.com", error: expect.stringContaining("404") });
    });

    test("rejects non-text content types with an error entry", async () => {
        mockFetch = mock(async (_url: string, _opts?: unknown) => makeMockResponse({ contentType: "image/png" }));
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com/image.png"] });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ error: expect.stringContaining("image/png") });
    });

    test("returns plain text as-is for non-HTML text content types", async () => {
        const plainText = "line one\nline two\nline three";
        mockFetch = mock(async (_url: string, _opts?: unknown) =>
            makeMockResponse({ contentType: "text/plain", body: plainText }),
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com/data.txt"] });

        expect((result[0] as { pageContents: string }).pageContents).toContain(plainText);
    });

    test("co-locates error and success entries when one URL fails", async () => {
        let callCount = 0;
        mockFetch = mock(async (_url: string, _opts?: unknown) => {
            callCount++;
            if (callCount === 1) {
                return makeMockResponse({ ok: false, status: 500, body: "Error" });
            }
            return makeMockResponse({ body: "<html><body><p>Good content</p></body></html>" });
        });
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://bad.com", "https://good.com"] });

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ url: "https://bad.com", error: expect.any(String) });
        expect((result[1] as { pageContents: string }).pageContents).toContain("Good content");
    });
});
