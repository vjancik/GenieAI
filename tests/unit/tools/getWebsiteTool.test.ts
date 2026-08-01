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

describe("fingerprint fallback", () => {
    /** The Rust-level error impit surfaces when the TLS handshake is rejected. */
    const TLS_ERROR = `Failed to connect to the server.
Reason: hyper_util::client::legacy::Error(
    Connect,
    Custom { kind: Other, error: Custom { kind: InvalidData,
        error: PeerMisbehaved(SelectedUnusableCipherSuiteForVersion) } },
)`;

    test("retries with the other fingerprint when the connection fails", async () => {
        // Some servers negotiate TLS successfully with one profile but not the other
        let attempt = 0;
        respond = () => {
            attempt++;
            if (attempt === 1) throw new Error(TLS_ERROR);
            return { body: "<html><body><p>Content served on the second profile</p></body></html>" };
        };

        const result = await invokeTool(["https://archive.example.com/page"]);

        expect(constructorOptions?.browser).toBe("chrome");
        expect(contentsOf(result[0])).toContain("Content served on the second profile");
    });

    test("does NOT retry an HTTP error status", async () => {
        // The server answered — a different fingerprint would get the same status
        respond = () => ({ ok: false, status: 404 });

        await invokeTool(["https://missing.example.com"]);

        expect(calls).toHaveLength(1);
    });

    test("does NOT retry an unsupported content type", async () => {
        respond = () => ({ contentType: "image/png" });

        await invokeTool(["https://example.com/image.png"]);

        expect(calls).toHaveLength(1);
    });

    test("summarizes a TLS failure instead of dumping the Rust trace", async () => {
        respond = () => {
            throw new Error(TLS_ERROR);
        };

        const result = await invokeTool(["https://archive.example.com/page"]);
        const { error, reason } = result[0] as { error: string; reason: string };

        expect(calls).toHaveLength(2);
        expect(reason).toBe("unreachable");
        expect(error).toContain("TLS configuration");
        expect(error).not.toContain("hyper_util");
        expect(error).not.toContain("PeerMisbehaved");
    });

    test("names a DNS failure specifically", async () => {
        respond = () => {
            throw new Error("dns error: failed to lookup address information");
        };

        const result = await invokeTool(["https://nonexistent.example.com"]);

        expect((result[0] as { error: string }).error).toContain("host name could not be resolved");
    });
});

describe("browser escalation", () => {
    /** Prose long enough to clear the content threshold. */
    const ARTICLE = `<html><body><article><h1>Real headline</h1>${"<p>The measured behaviour of the system under load differs from the model, which suggests the queueing assumptions need revisiting.</p>".repeat(8)}</article></body></html>`;
    /** An SPA shell: ships its app inline, renders nothing server-side. */
    const SHELL = `<html><body><div id="root"></div><script>${"const x=1;".repeat(500)}</script></body></html>`;
    const CHALLENGE = "<html><body><p>Please enable JS and disable any ad blocker</p></body></html>";

    /** Minimal BrowserPageFetcher stand-in. */
    function fakeFetcher(html: string | (() => never)) {
        const calls: string[] = [];
        return {
            calls,
            fetcher: {
                fetchRenderedHtml: async (url: string) => {
                    calls.push(url);
                    if (typeof html === "function") return html();
                    return html;
                },
            },
        };
    }

    async function invokeWithFetcher(urls: string[], fetcher: { fetchRenderedHtml: (u: string) => Promise<string> }) {
        const { createGetWebsiteTool } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");
        // TYPE COERCION: test double implements the only method the tool calls
        return createGetWebsiteTool(testLogger, fetcher as never).invoke({ urls });
    }

    test("renders a client-rendered shell with the browser", async () => {
        respond = () => ({ body: SHELL });
        const { calls: rendered, fetcher } = fakeFetcher(ARTICLE);

        const result = await invokeWithFetcher(["https://spa.example.com"], fetcher);

        expect(rendered).toEqual(["https://spa.example.com"]);
        expect(contentsOf(result[0])).toContain("Real headline");
    });

    test("renders a bot-challenge page with the browser", async () => {
        respond = () => ({ body: CHALLENGE });
        const { calls: rendered, fetcher } = fakeFetcher(ARTICLE);

        const result = await invokeWithFetcher(["https://blocked.example.com"], fetcher);

        expect(rendered).toHaveLength(1);
        expect(contentsOf(result[0])).toContain("Real headline");
    });

    test("does NOT escalate a page that already has content", async () => {
        respond = () => ({ body: ARTICLE });
        const { calls: rendered, fetcher } = fakeFetcher(ARTICLE);

        await invokeWithFetcher(["https://good.example.com"], fetcher);

        expect(rendered).toHaveLength(0);
    });

    test("does NOT escalate a short but complete page, and returns its content", async () => {
        respond = () => ({ body: "<html><body><h1>Status</h1><p>All systems operational.</p></body></html>" });
        const { calls: rendered, fetcher } = fakeFetcher(ARTICLE);

        const result = await invokeWithFetcher(["https://status.example.com"], fetcher);

        expect(rendered).toHaveLength(0);
        expect(contentsOf(result[0])).toContain("All systems operational");
    });

    test("reports the reason when the browser render also fails", async () => {
        respond = () => ({ body: CHALLENGE });
        const { fetcher } = fakeFetcher(CHALLENGE);

        const result = await invokeWithFetcher(["https://blocked.example.com"], fetcher);

        expect(result[0]).toMatchObject({ reason: "blocked" });
        expect((result[0] as { error: string }).error).toContain("bot protection");
    });

    test("reports the original problem when rendering itself throws", async () => {
        respond = () => ({ body: SHELL });
        const { fetcher } = fakeFetcher(() => {
            throw new Error("net::ERR_ABORTED");
        });

        const result = await invokeWithFetcher(["https://spa.example.com"], fetcher);

        expect(result[0]).toMatchObject({ reason: "client-rendered" });
    });

    test("reports client-rendered pages as failures when no browser is configured", async () => {
        respond = () => ({ body: SHELL });

        const result = await invokeTool(["https://spa.example.com"]);

        expect(result[0]).toMatchObject({ reason: "client-rendered" });
        expect((result[0] as { error: string }).error).toContain("JavaScript");
    });
});

describe("failure reporting", () => {
    test("distinguishes HTTP status failures", async () => {
        respond = () => ({ ok: false, status: 404 });

        const result = await invokeTool(["https://missing.example.com"]);

        expect(result[0]).toMatchObject({ reason: "http-error" });
        expect((result[0] as { error: string }).error).toContain("404");
    });

    test("distinguishes unsupported content types", async () => {
        respond = () => ({ contentType: "image/png" });

        const result = await invokeTool(["https://example.com/image.png"]);

        expect(result[0]).toMatchObject({ reason: "unsupported-content" });
    });

    test("reports a paywall as its own reason", async () => {
        respond = () => ({
            body:
                "<html><body><article><h1>Headline</h1><p>Opening paragraph.</p>" +
                "<p>Subscribe to continue reading this article.</p></article>" +
                `<nav>${"<a href='/x'>Section link text</a>".repeat(120)}</nav></body></html>`,
        });

        const result = await invokeTool(["https://paywalled.example.com"]);

        expect(result[0]).toMatchObject({ reason: "paywalled" });
        expect((result[0] as { error: string }).error).toContain("paywall");
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

    test("does not emit raw HTML for layout tables", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        // Tables without a heading row are used for page layout on older sites. The
        // GFM plugin keeps those as raw HTML unless overridden.
        const md = bodyToContent(
            html("<table><tr><td><b>Site name</b></td><td>Some body copy in a layout cell.</td></tr></table>"),
            "text/html",
        );

        expect(md).not.toContain("<table");
        expect(md).not.toContain("<td");
        expect(md).toContain("Site name");
        expect(md).toContain("Some body copy in a layout cell.");
    });

    test("returns non-HTML textual bodies unchanged", async () => {
        const { bodyToContent } = await import("../../../src/infrastructure/llm/tools/getWebsiteTool.ts");

        const payload = '{"a":1}';
        expect(bodyToContent(payload, "application/json")).toBe(payload);
        expect(bodyToContent("a,b\n1,2", "text/csv")).toBe("a,b\n1,2");
    });
});
