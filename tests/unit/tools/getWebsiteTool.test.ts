import { beforeEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";

const testLogger = pino({ level: "silent" });

type ImpitCall = { url: string; method: string; body?: string };
type ImpitReply = { ok?: boolean; status?: number; contentType?: string; body?: string; url?: string };

/** Records every request the tool makes through Impit, across all tests. */
let calls: ImpitCall[] = [];
/** Constructor options the tool passed to Impit — asserted for the browser preset. */
let constructorOptions: Record<string, unknown> | undefined;
/** Per-test responder; receives each request in order. */
let respond: (call: ImpitCall) => ImpitReply = () => ({});

function toResponse(reply: ImpitReply, requestUrl: string) {
    const body = reply.body ?? "<html><body><h1>Hello</h1><p>World</p></body></html>";
    return {
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        url: reply.url ?? requestUrl,
        headers: new Headers({ "content-type": reply.contentType ?? "text/html" }),
        text: async () => body,
    };
}

// The tool constructs Impit directly, so the module is replaced wholesale.
mock.module("impit", () => ({
    Impit: class MockImpit {
        constructor(options: Record<string, unknown>) {
            constructorOptions = options;
        }
        fetch(url: string, init?: { method?: string; body?: string }) {
            const call: ImpitCall = { url, method: init?.method ?? "GET", body: init?.body };
            calls.push(call);
            return Promise.resolve(toResponse(respond(call), url));
        }
    },
}));

/** Imports the tool fresh and invokes it against the given URLs. */
async function invokeTool(urls: string[]) {
    const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
    return createGetWebsiteTool(testLogger).invoke({ urls });
}

const contentsOf = (entry: unknown) => (entry as { pageContents: string }).pageContents;

beforeEach(() => {
    calls = [];
    constructorOptions = undefined;
    respond = () => ({});
});

describe("createGetWebsiteTool", () => {
    test("fetches a URL and converts HTML to markdown", async () => {
        const result = await invokeTool(["https://example.com"]);

        expect(calls).toHaveLength(1);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ url: "https://example.com" });
        expect(contentsOf(result[0])).toContain("Hello");
        expect(contentsOf(result[0])).toContain("World");
    });

    test("requests through Impit's Firefox preset, following redirects", async () => {
        await invokeTool(["https://example.com"]);

        expect(constructorOptions).toMatchObject({ browser: "firefox", followRedirects: true });
        // Impit's preset supplies the fingerprint headers; only content negotiation is overridden
        expect(constructorOptions?.headers).toEqual({ "accept-language": "en-US,en;q=0.9" });
    });

    test("deduplicates URLs before fetching", async () => {
        const result = await invokeTool(["https://example.com", "https://example.com"]);

        expect(calls).toHaveLength(1);
        expect(result).toHaveLength(1);
    });

    test("handles multiple distinct URLs", async () => {
        respond = (call) => ({ body: `<html><body><p>Content from ${call.url}</p></body></html>` });

        const result = await invokeTool(["https://example.com", "https://other.com"]);

        expect(calls).toHaveLength(2);
        expect(result).toHaveLength(2);
        expect(contentsOf(result[0])).toContain("https://example.com");
        expect(contentsOf(result[1])).toContain("https://other.com");
    });

    test("returns error entry when a URL returns HTTP error", async () => {
        respond = () => ({ ok: false, status: 404, body: "Not Found" });

        const result = await invokeTool(["https://bad.example.com"]);

        expect(result[0]).toMatchObject({
            url: "https://bad.example.com",
            error: expect.stringContaining("https://bad.example.com"),
        });
    });

    test("rejects non-text content types with an error entry", async () => {
        respond = () => ({ contentType: "image/png" });

        const result = await invokeTool(["https://example.com/image.png"]);

        expect(result[0]).toMatchObject({
            url: "https://example.com/image.png",
            error: expect.stringContaining("https://example.com/image.png"),
        });
    });

    test("returns plain text as-is for non-HTML text content types", async () => {
        const plainText = "line one\nline two\nline three";
        respond = () => ({ contentType: "text/plain", body: plainText });

        const result = await invokeTool(["https://example.com/data.txt"]);

        expect(contentsOf(result[0])).toContain(plainText);
    });

    test("accepts XHTML and converts it to markdown", async () => {
        respond = () => ({
            contentType: "application/xhtml+xml",
            body: "<html><body><h1>Title</h1><p>Paragraph</p></body></html>",
        });

        const result = await invokeTool(["https://example.com/doc.xhtml"]);

        expect(contentsOf(result[0])).toContain("# Title");
        expect(contentsOf(result[0])).toContain("Paragraph");
    });

    test("accepts textual application/* types and returns them verbatim", async () => {
        const payload = '{"key":"value"}';
        for (const contentType of ["application/json", "application/ld+json", "application/rss+xml"]) {
            respond = () => ({ contentType, body: payload });

            const result = await invokeTool(["https://example.com/api"]);

            expect(contentsOf(result[0])).toBe(payload);
        }
    });

    test("co-locates error and success entries when one URL fails", async () => {
        respond = (call) =>
            call.url === "https://bad.com"
                ? { ok: false, status: 500, body: "Error" }
                : { body: "<html><body><p>Good content</p></body></html>" };

        const result = await invokeTool(["https://bad.com", "https://good.com"]);

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ url: "https://bad.com", error: expect.any(String) });
        expect(contentsOf(result[1])).toContain("Good content");
    });
});

describe("consent interstitials", () => {
    const CONSENT_PAGE =
        "<html><body><h1>Your privacy choices</h1>" +
        '<form class="consent-form" method="post">' +
        '<input type="hidden" name="csrfToken" value="tok123">' +
        '<input type="hidden" name="sessionId" value="sess456">' +
        '<input type="hidden" name="originalDoneUrl" value="https://news.example.com/story?a&#x3D;1">' +
        '<button type="submit" name="agree">Accept all</button>' +
        "</form></body></html>";

    test("accepts the consent form and returns the real article", async () => {
        // Consent gates answer 200 with the wall, so only the body distinguishes them
        respond = (call) =>
            call.method === "POST"
                ? { body: "<html><body><p>The actual article body</p></body></html>" }
                : { body: CONSENT_PAGE, url: "https://consent.example.com/collectConsent" };

        const result = await invokeTool(["https://news.example.com/story"]);

        expect(calls).toHaveLength(2);
        expect(contentsOf(result[0])).toContain("The actual article body");
        expect(contentsOf(result[0])).not.toContain("consent");
    });

    test("replays the form's hidden fields with an agree value", async () => {
        respond = (call) =>
            call.method === "POST"
                ? { body: "<html><body><p>Article</p></body></html>" }
                : { body: CONSENT_PAGE, url: "https://consent.example.com/collectConsent" };

        await invokeTool(["https://news.example.com/story"]);

        const post = calls.find((c) => c.method === "POST");
        expect(post?.url).toBe("https://consent.example.com/collectConsent");
        const fields = new URLSearchParams(post?.body ?? "");
        expect(fields.get("csrfToken")).toBe("tok123");
        expect(fields.get("sessionId")).toBe("sess456");
        // Entity-encoded field values must be decoded before being replayed
        expect(fields.get("originalDoneUrl")).toBe("https://news.example.com/story?a=1");
        expect(fields.get("agree")).toBe("agree");
    });

    test("falls back to the original body when consent submission stays gated", async () => {
        respond = () => ({ body: CONSENT_PAGE, url: "https://consent.example.com/collectConsent" });

        const result = await invokeTool(["https://news.example.com/story"]);

        // Better to hand back the wall than to fail outright — the LLM can report it
        expect(contentsOf(result[0])).toContain("Your privacy choices");
    });

    test("leaves ordinary pages untouched", async () => {
        respond = () => ({ body: "<html><body><p>No consent gate here</p></body></html>" });

        const result = await invokeTool(["https://example.com"]);

        expect(calls).toHaveLength(1);
        expect(contentsOf(result[0])).toContain("No consent gate here");
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
