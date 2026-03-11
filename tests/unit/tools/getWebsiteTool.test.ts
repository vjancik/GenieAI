import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";

// We need to mock fetch before importing the module under test
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

const testLogger = pino({ level: "silent" });

describe("createGetWebsiteTool", () => {
    beforeEach(() => {
        mockFetch = mock(async (_url: string) => ({
            ok: true,
            status: 200,
            text: async () => "<html><body><h1>Hello</h1><p>World</p></body></html>",
        }));
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
        expect(mockFetch).toHaveBeenCalledWith("https://example.com");
        expect(result).toContain("## https://example.com");
        expect(result).toContain("Hello");
        expect(result).toContain("World");
    });

    test("deduplicates URLs before fetching", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        await tool.invoke({
            urls: ["https://example.com", "https://example.com"],
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("handles multiple distinct URLs", async () => {
        mockFetch = mock(async (url: string) => ({
            ok: true,
            status: 200,
            text: async () => `<html><body><p>Content from ${url}</p></body></html>`,
        }));
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({
            urls: ["https://example.com", "https://other.com"],
        });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result).toContain("## https://example.com");
        expect(result).toContain("## https://other.com");
        expect(result).toContain("---");
    });

    test("includes error message inline when a URL fails", async () => {
        mockFetch = mock(async (_url: string) => ({
            ok: false,
            status: 404,
            text: async () => "Not Found",
        }));
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://bad.example.com"] });

        expect(result).toContain("## https://bad.example.com");
        expect(result).toContain("Error:");
        expect(result).toContain("404");
    });

    test("continues processing other URLs when one fails", async () => {
        let callCount = 0;
        mockFetch = mock(async (_url: string) => {
            callCount++;
            if (callCount === 1) {
                return { ok: false, status: 500, text: async () => "Error" };
            }
            return {
                ok: true,
                status: 200,
                text: async () => "<html><body><p>Good content</p></body></html>",
            };
        });
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({
            urls: ["https://bad.com", "https://good.com"],
        });

        expect(result).toContain("Error:");
        expect(result).toContain("Good content");
    });
});
