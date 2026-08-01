import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { makeMockResponse, spyFetchTooling } from "../../helpers/fetchHelpers.ts";

const testLogger = pino({ level: "silent" });

describe("createGetWebsiteTool", () => {
    // `spyFetchTooling` reports only the fetches the tool itself makes, excluding
    // any LangSmith tracing `/info` probe that LangChain may fire through the
    // global fetch — keeping call-count assertions stable regardless of whether
    // tracing is enabled in the environment.
    let fetchMock: ReturnType<typeof spyFetchTooling>;

    beforeEach(() => {
        fetchMock = spyFetchTooling(() => makeMockResponse());
    });

    afterEach(() => {
        fetchMock.restore();
    });

    test("fetches a URL and converts HTML to markdown", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com"] });

        expect(fetchMock.toolCalls()).toBe(1);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect((result[0] as { pageContents: string }).pageContents).toContain("Hello");
        expect((result[0] as { pageContents: string }).pageContents).toContain("World");
    });

    test("sends browser-like headers", async () => {
        let capturedInit: RequestInit | undefined;
        fetchMock.restore();
        fetchMock = spyFetchTooling((_url, init) => {
            capturedInit = init;
            return makeMockResponse();
        });

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        await tool.invoke({ urls: ["https://example.com"] });

        const callHeaders = capturedInit?.headers as Record<string, string> | undefined;
        expect(callHeaders?.["user-agent"]).toContain("Chrome");
    });

    test("deduplicates URLs before fetching", async () => {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com", "https://example.com"] });

        expect(fetchMock.toolCalls()).toBe(1);
        expect(result).toHaveLength(1);
    });

    test("handles multiple distinct URLs", async () => {
        fetchMock.restore();
        fetchMock = spyFetchTooling((url) =>
            makeMockResponse({ body: `<html><body><p>Content from ${url}</p></body></html>` }),
        );

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com", "https://other.com"] });

        expect(fetchMock.toolCalls()).toBe(2);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect(result[1]).toMatchObject({ url: "https://other.com" });
    });

    test("returns error entry when a URL returns HTTP error", async () => {
        fetchMock.restore();
        fetchMock = spyFetchTooling(() => makeMockResponse({ ok: false, status: 404, body: "Not Found" }));

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
        fetchMock.restore();
        fetchMock = spyFetchTooling(() => makeMockResponse({ contentType: "image/png" }));

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
        fetchMock.restore();
        fetchMock = spyFetchTooling(() => makeMockResponse({ contentType: "text/plain", body: plainText }));

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const tool = createGetWebsiteTool(testLogger);

        const result = await tool.invoke({ urls: ["https://example.com/data.txt"] });

        expect((result[0] as { pageContents: string }).pageContents).toContain(plainText);
    });

    test("accepts XHTML and converts it to markdown", async () => {
        fetchMock.restore();
        fetchMock = spyFetchTooling(() =>
            makeMockResponse({
                contentType: "application/xhtml+xml",
                body: "<html><body><h1>Title</h1><p>Paragraph</p></body></html>",
            }),
        );

        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        const result = await createGetWebsiteTool(testLogger).invoke({ urls: ["https://example.com/doc.xhtml"] });

        const contents = (result[0] as { pageContents: string }).pageContents;
        expect(contents).toContain("# Title");
        expect(contents).toContain("Paragraph");
    });

    test("accepts textual application/* types and returns them verbatim", async () => {
        const payload = '{"key":"value"}';
        for (const contentType of ["application/json", "application/ld+json", "application/rss+xml"]) {
            fetchMock.restore();
            fetchMock = spyFetchTooling(() => makeMockResponse({ contentType, body: payload }));

            const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
            const result = await createGetWebsiteTool(testLogger).invoke({ urls: ["https://example.com/api"] });

            expect((result[0] as { pageContents: string }).pageContents).toBe(payload);
        }
    });

    test("co-locates error and success entries when one URL fails", async () => {
        fetchMock.restore();
        let callCount = 0;
        fetchMock = spyFetchTooling(() => {
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

describe("bodyToContent", () => {
    const html = (body: string) => `<html><body>${body}</body></html>`;

    test("does not leak inline SVG stylesheets into link text", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        // A logo link wrapping an inline SVG — `node.textContent` would splice the
        // stylesheet into the link label, bypassing element removal.
        const md = bodyToContent(
            html('<a href="/"><svg><style>.cls-1{fill:none;}</style><path d="M0 0"/></svg>Acme</a>'),
            "text/html",
        );

        expect(md).not.toContain("cls-1");
        expect(md).not.toContain("fill:none");
        expect(md).toContain("Acme");
    });

    test("strips navigation and footer chrome", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        const md = bodyToContent(
            html('<nav><a href="/">Nav link</a></nav><p>Real body</p><footer>Footer chrome</footer>'),
            "text/html",
        );

        expect(md).toContain("Real body");
        expect(md).not.toContain("Nav link");
        expect(md).not.toContain("Footer chrome");
    });

    test("preserves body content inside <header>", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        // Regression guard: publishers place article standfirsts and captions in
        // <header>, so it must not be stripped alongside nav/footer.
        const md = bodyToContent(
            html("<article><header><p>Standfirst carrying real body text</p></header><p>Body</p></article>"),
            "text/html",
        );

        expect(md).toContain("Standfirst carrying real body text");
        expect(md).toContain("Body");
    });

    test("converts tables to markdown pipe tables", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        const md = bodyToContent(
            html(
                "<table><thead><tr><th>Substance</th><th>Count</th></tr></thead>" +
                    "<tbody><tr><td>tobacco</td><td>52 million</td></tr></tbody></table>",
            ),
            "text/html",
        );

        // Without table support these cells collapse into an undelimited run of text
        expect(md).toContain("| Substance | Count |");
        expect(md).toContain("| tobacco | 52 million |");
    });

    test("returns non-HTML textual bodies unchanged", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        const payload = '{"a":1}';
        expect(bodyToContent(payload, "application/json")).toBe(payload);
        expect(bodyToContent("a,b\n1,2", "text/csv")).toBe("a,b\n1,2");
    });
});
