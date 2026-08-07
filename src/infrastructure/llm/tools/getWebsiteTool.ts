import { tool } from "@langchain/core/tools";
import { Impit } from "impit";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "zod";
import { parseMimeType } from "../../../application/helpers/parseMimeType.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import type { WebFetchFailure } from "../../../domain/errors/AppError.ts";
import { ToolError, WebFetchError } from "../../../domain/errors/AppError.ts";
import type { BrowserPageFetcher } from "../../browser/BrowserPageFetcher.ts";
import { analyzePage, describeProblem } from "../../http/pageAnalysis.ts";

/**
 * Content-negotiation headers.
 *
 * Impit's browser preset already supplies a complete, self-consistent request
 * signature (TLS/JA3 handshake, HTTP/2 settings, and the matching `user-agent`,
 * `accept` and `sec-*` headers). Overriding those made no measurable difference
 * to whether a site served content, so only headers that change *what* the
 * server returns are set here.
 */
const CONTENT_HEADERS: Record<string, string> = {
    "accept-language": "en-US,en;q=0.9",
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 20;

/**
 * Elements that never carry article body text: scripts and styles, embedded
 * media containers, interactive controls, and site-level navigation.
 *
 * `header` and `aside` are deliberately NOT listed. Some publishers place the
 * article standfirst and image captions inside `<header>`, so removing it
 * silently drops body content.
 */
const NON_CONTENT_ELEMENTS: TurndownService.TagName[] = [
    "script",
    "style",
    "noscript",
    "iframe",
    "form",
    "template",
    "canvas",
    "object",
    "embed",
    "select",
    "button",
    "nav",
    "footer",
];

const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    // The GFM plugin `keep`s tables that have no heading row, which emits their raw
    // HTML. Sites that lay pages out with nested tables would then dump markup into
    // the output. Rendering the processed content instead keeps the text and drops
    // the markup, while real data tables still become pipe tables.
    keepReplacement: (content) => content,
});
turndown.remove(NON_CONTENT_ELEMENTS);
// `svg` lives in the SVG tag map rather than the HTML one Turndown's types accept,
// so it is matched by node name instead of being listed above.
turndown.remove((node) => node.nodeName.toLowerCase() === "svg");
// Adds table support — without it, table cells collapse into an undelimited run
// of text ("tobacco 52 million alcohol 17 million ...") that loses row/column structure.
turndown.use(gfm);
// Strip href/src from links and media to keep output concise — only preserve visible text
turndown.addRule("linksWithoutHrefs", {
    filter: ["a", "img", "video", "audio"],
    // Uses Turndown's already-processed `content` rather than `node.textContent`:
    // textContent reads raw descendant text, bypassing the removals above, which
    // leaked inline SVG stylesheets (".cls-1{fill:none;}...") into link text.
    replacement: (content) => {
        const text = content.trim();
        return text ? `[${text}]()` : "";
    },
});

/** Media types converted to Markdown rather than returned verbatim. */
const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Textual media types outside the `text/*` tree. Structured-syntax suffixes
 * (`+json`, `+xml`) are handled separately by {@link isTextualMimeType}, so
 * only the bare types need listing here.
 */
const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
    "application/json",
    "application/xml",
    "application/javascript",
    "application/ecmascript",
    "application/yaml",
    "application/x-yaml",
    "application/csv",
]);

/**
 * Whether a media type carries human-readable text.
 *
 * Covers the whole `text/*` tree plus the textual `application/*` types that
 * real pages and APIs serve — `application/xhtml+xml` for XHTML documents,
 * and structured-suffix types such as `application/ld+json` or
 * `application/rss+xml` (RFC 6839), which are textual by definition.
 */
function isTextualMimeType(mimeType: string): boolean {
    if (mimeType.startsWith("text/")) return true;
    if (TEXTUAL_APPLICATION_MIME_TYPES.has(mimeType)) return true;
    if (HTML_MIME_TYPES.has(mimeType)) return true;
    return /^application\/[\w.-]+\+(?:json|xml)$/.test(mimeType);
}

/**
 * Minimal in-memory cookie jar matching Impit's `cookieJar` contract.
 *
 * Cookies are grouped by registrable domain (approximated as the last two
 * labels of the host) so a redirect chain that hops between subdomains — as
 * consent interstitials do, e.g. `www.yahoo.com` → `guce.yahoo.com` →
 * `consent.yahoo.com` — carries its session forward.
 *
 * A jar is created per fetch, so cookies never leak between unrelated requests.
 */
function createCookieJar() {
    const byDomain = new Map<string, Map<string, string>>();
    const registrableDomain = (url: string) => new URL(url).hostname.split(".").slice(-2).join(".");

    return {
        setCookie(cookie: string, url: string): void {
            // Only the leading `name=value` pair matters; attributes are ignored
            const pair = cookie.split(";")[0];
            const separator = pair?.indexOf("=") ?? -1;
            if (!pair || separator < 1) return;
            const domain = registrableDomain(url);
            const cookies = byDomain.get(domain) ?? new Map<string, string>();
            cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
            byDomain.set(domain, cookies);
        },
        getCookieString(url: string): string {
            const cookies = byDomain.get(registrableDomain(url));
            if (!cookies) return "";
            return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        },
    };
}

/** Marks a response as a GDPR consent interstitial rather than the requested page. */
const CONSENT_FORM_PATTERN = /consent-form|collectConsent/i;

/** Decodes the HTML entities that appear in serialized form field values. */
function decodeHtmlEntities(value: string): string {
    return (
        value
            .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            // Must run last, so an encoded `&amp;lt;` does not become `<`
            .replace(/&amp;/g, "&")
    );
}

/**
 * Accepts a GDPR consent interstitial by replaying its form.
 *
 * Consent gates answer with HTTP 200 and a cookie-policy page in place of the
 * article, so they cannot be detected from the status code. Submitting the
 * form's hidden fields (CSRF token, session id, original destination) together
 * with an `agree` value sets the consent cookies and redirects to the real page.
 *
 * @returns The consented page's HTML, or `null` if the form could not be replayed.
 */
async function acceptConsentForm(impit: Impit, url: string, html: string): Promise<string | null> {
    const form = new URLSearchParams();
    for (const input of html.match(/<input[^>]*>/gi) ?? []) {
        const name = input.match(/name=["']([^"']+)["']/i)?.[1];
        const type = input.match(/type=["']([^"']+)["']/i)?.[1]?.toLowerCase();
        const value = input.match(/value=["']([^"']*)["']/i)?.[1] ?? "";
        if (name && type === "hidden") form.append(name, decodeHtmlEntities(value));
    }

    // No hidden fields means this is not a consent form we know how to replay
    if ([...form].length === 0) return null;
    form.append("agree", "agree");

    const res = await impit.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", referer: url },
        body: form.toString(),
    });
    if (!res.ok) return null;

    const consented = await res.text();
    // Still gated — treat the attempt as failed rather than returning the wall
    return CONSENT_FORM_PATTERN.test(consented) ? null : consented;
}

/**
 * Browser fingerprints to try, in order.
 *
 * Firefox is preferred: some sites (NCBI among them) reject Impit's Chrome
 * fingerprint outright. Chrome is the fallback because the two negotiate TLS
 * differently — archive.today's servers pick a cipher suite that the Firefox
 * profile's TLS stack rejects as invalid, while the Chrome profile connects.
 */
const IMPIT_PROFILES = ["firefox", "chrome"] as const;

/**
 * Result of one fetch attempt.
 *
 * An error status is reported rather than thrown so the body travels with it —
 * bot walls answer with a 4xx whose body is a challenge page, which the caller
 * needs in order to distinguish a block from an ordinary HTTP failure.
 */
type FetchOutcome = { body: string; contentType: string; status: number; ok: boolean };

/** Performs one fetch attempt with a specific browser fingerprint. */
async function fetchWithProfile(url: string, browser: (typeof IMPIT_PROFILES)[number]): Promise<FetchOutcome> {
    const impit = new Impit({
        browser,
        followRedirects: true,
        maxRedirects: MAX_REDIRECTS,
        timeout: REQUEST_TIMEOUT_MS,
        cookieJar: createCookieJar(),
        headers: CONTENT_HEADERS,
    });

    const res = await impit.fetch(url);
    const mimeType = parseMimeType(res.headers.get("content-type")) ?? "";

    if (!res.ok) {
        // Bot protections answer with a 4xx *and* a challenge page. Keeping the body
        // lets the caller recognize a wall rather than reporting a bare status code,
        // and decide whether a browser render is worth attempting.
        const body = HTML_MIME_TYPES.has(mimeType) ? await res.text() : "";
        return { body, contentType: mimeType, status: res.status, ok: false };
    }

    if (!isTextualMimeType(mimeType)) {
        throw new ToolError(`Unsupported content type "${mimeType}" — only textual responses are supported`);
    }

    const body = await res.text();

    if (HTML_MIME_TYPES.has(mimeType) && CONSENT_FORM_PATTERN.test(body)) {
        const consented = await acceptConsentForm(impit, res.url, body);
        if (consented !== null) return { body: consented, contentType: mimeType, status: res.status, ok: true };
    }

    return { body, contentType: mimeType, status: res.status, ok: true };
}

/**
 * Fetches a URL and returns its body as text, enforcing that the Content-Type
 * is textual (see {@link isTextualMimeType}). Binary responses (images,
 * archives, etc.) are rejected with a ToolError.
 *
 * Requests go through Impit rather than the platform `fetch`. Many publishers
 * reject requests by TLS/HTTP2 fingerprint regardless of how browser-like the
 * headers are, which `fetch` cannot work around.
 *
 * A transport-level failure is retried once with the other fingerprint, since
 * the two negotiate TLS differently. Responses that arrived successfully — an
 * HTTP error status, an unsupported content type — are not retried, because the
 * fingerprint would not change them.
 *
 * GDPR consent interstitials encountered along the way are accepted
 * automatically (see {@link acceptConsentForm}).
 */
export async function fetchTextBody(url: string): Promise<FetchOutcome> {
    let lastTransportError: unknown;

    for (const profile of IMPIT_PROFILES) {
        try {
            return await fetchWithProfile(url, profile);
        } catch (err) {
            // ToolError means the server answered and we rejected the response;
            // only connection-level failures are worth another fingerprint.
            if (err instanceof ToolError) throw err;
            lastTransportError = err;
        }
    }

    throw new ToolError(`Failed to connect: ${summarizeTransportError(lastTransportError)}`, lastTransportError);
}

/**
 * Reduces a transport failure to one line.
 *
 * Impit surfaces multi-line Rust debug output (`hyper_util::client::legacy::Error(...)`)
 * that is meaningless to a user, so the underlying cause is named where it can be
 * recognized and the full text is kept on the error's `cause` for logs.
 */
function summarizeTransportError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (/SelectedUnusableCipherSuiteForVersion|PeerMisbehaved|InvalidCertificate|HandshakeFailure/i.test(message)) {
        return "the server's TLS configuration was rejected during the security handshake";
    }
    if (/dns error|failed to lookup address|NotFound/i.test(message)) {
        return "the host name could not be resolved";
    }
    if (/Connection refused|ConnectionReset|ECONNREFUSED/i.test(message)) {
        return "the connection was refused";
    }
    // Fall back to the first line rather than the whole Rust debug dump
    return message.split("\n")[0] ?? "unknown connection error";
}

/**
 * Converts a fetched page body to a readable string for the LLM:
 * - HTML/XHTML → converted to Markdown via Turndown
 * - other textual types → returned as-is (plain text, JSON, XML, CSV, etc.)
 */
export function bodyToContent(body: string, contentType: string): string {
    if (HTML_MIME_TYPES.has(contentType)) {
        return turndown.turndown(body);
    }
    return body;
}

/** Successful result for a single URL fetch. */
export type WebsiteResult = { url: string; pageContents: string };
/** Error result for a single URL fetch, with a machine-readable reason. */
export type WebsiteError = { url: string; error: string; reason: WebFetchFailure };
/** Union result type returned per URL by the website tool. */
export type WebsiteResultEntry = WebsiteResult | WebsiteError;

/**
 * Handles a response that arrived with an error status.
 *
 * Bot protections commonly answer 401/403 with a JavaScript challenge page, so
 * the body decides what happened rather than the status code alone: a challenge
 * is worth a browser render and is reported as a block, while an ordinary error
 * page is reported as the HTTP failure it is.
 */
async function handleErrorResponse(
    url: string,
    body: string,
    status: number,
    logger: Logger,
    browserFetcher?: BrowserPageFetcher,
): Promise<string> {
    const analysis = body.length > 0 ? analyzePage(body) : null;

    if (analysis?.shouldRenderWithBrowser && browserFetcher !== undefined) {
        logger.debug({ url, status, problem: analysis.problem }, "Escalating error response to browser render");
        const rendered = await browserFetcher.fetchRenderedHtml(url).catch((err: unknown) => {
            logger.warn({ url, err }, "Browser render of error response failed");
            return null;
        });
        if (rendered !== null) {
            const renderedAnalysis = analyzePage(rendered);
            if (renderedAnalysis.hasContent) return bodyToContent(rendered, "text/html");
        }
    }

    if (analysis?.problem === "blocked") {
        throw new WebFetchError("blocked", `${url}: ${describeProblem("blocked")} — HTTP ${status}`);
    }
    throw new WebFetchError("http-error", `${url}: the server responded with HTTP ${status}`);
}

/**
 * Retrieves a URL, escalating to a real browser when the plain fetch produced a
 * page whose content only exists after JavaScript runs.
 *
 * Escalation requires positive evidence that rendering would change the outcome
 * (see {@link analyzePage}); thin content alone is not enough, since a short but
 * complete page is indistinguishable from an unrendered shell.
 */
async function retrievePage(url: string, logger: Logger, browserFetcher?: BrowserPageFetcher): Promise<string> {
    const { body, contentType, status, ok } = await fetchTextBody(url);

    if (!ok) {
        return handleErrorResponse(url, body, status, logger, browserFetcher);
    }

    // Only HTML is worth analyzing — JSON, CSV and plain text are returned as fetched
    if (!HTML_MIME_TYPES.has(contentType)) {
        return bodyToContent(body, contentType);
    }

    const analysis = analyzePage(body);
    if (analysis.hasContent) {
        return bodyToContent(body, contentType);
    }

    if (analysis.shouldRenderWithBrowser && browserFetcher !== undefined) {
        logger.debug({ url, problem: analysis.problem }, "Escalating to browser render");
        try {
            const rendered = await browserFetcher.fetchRenderedHtml(url);
            const renderedAnalysis = analyzePage(rendered);
            if (renderedAnalysis.hasContent) {
                return bodyToContent(rendered, "text/html");
            }
            // The browser did not help either — report why it still failed
            logger.debug({ url, problem: renderedAnalysis.problem }, "Browser render did not yield content");
            throw new WebFetchError(
                renderedAnalysis.problem ?? "empty",
                `${url}: ${describeProblem(renderedAnalysis.problem ?? "empty")} (also after rendering with a browser)`,
            );
        } catch (err) {
            if (err instanceof WebFetchError) throw err;
            // Rendering itself failed (navigation timeout, crashed browser, …)
            logger.warn({ url, err }, "Browser render failed");
            throw new WebFetchError(
                analysis.problem ?? "empty",
                `${url}: ${describeProblem(analysis.problem ?? "empty")} and rendering it with a browser failed`,
                err,
            );
        }
    }

    // Thin, but with no sign of a wall or of client-side rendering: a genuinely
    // short page. Return what it has rather than reporting a failure — the
    // content threshold exists to trigger escalation, not to reject small pages.
    if (analysis.problem === "empty" && analysis.contentChars > 0) {
        return bodyToContent(body, contentType);
    }

    throw new WebFetchError(analysis.problem ?? "empty", `${url}: ${describeProblem(analysis.problem ?? "empty")}`);
}

/** Maps a thrown error to the reason/message pair reported back to the model. */
function toWebsiteError(url: string, err: unknown): WebsiteError {
    if (err instanceof WebFetchError) {
        return { url, error: err.message, reason: err.reason };
    }
    const message = err instanceof Error ? err.message : String(err);

    if (/timed? ?out|timeout|deadline/i.test(message)) {
        return { url, error: `${url}: the request timed out`, reason: "timeout" };
    }
    const status = message.match(/^HTTP (\d{3})$/)?.[1];
    if (status !== undefined) {
        return { url, error: `${url}: the server responded with HTTP ${status}`, reason: "http-error" };
    }
    if (/Unsupported content type/i.test(message)) {
        return {
            url,
            error: `${url}: ${message.replace(/^Unsupported/, "unsupported")}`,
            reason: "unsupported-content",
        };
    }
    const connectFailure = message.match(/^Failed to connect: (.+)$/s)?.[1];
    if (connectFailure !== undefined) {
        return { url, error: `${url}: could not be reached — ${connectFailure}`, reason: "unreachable" };
    }
    return { url, error: `${url}: could not be reached (${message.split("\n")[0]})`, reason: "unreachable" };
}

/**
 * Creates a LangChain tool that fetches one or more URLs and returns their
 * content as a structured array, one entry per URL. HTML pages are converted
 * to Markdown; other textual types are returned verbatim. Non-textual content
 * types are rejected. Individual URL failures are co-located with the URL in an
 * error entry carrying a reason, so the model can tell the user whether a page
 * was blocked, paywalled, or simply unreachable.
 *
 * Duplicate URLs are deduplicated before fetching.
 *
 * @param logger - Injectable logger for testability
 * @param browserFetcher - Optional browser fallback for client-rendered pages and
 *   JS bot challenges. Without it, such pages are reported as failures.
 */
export function createGetWebsiteTool(logger: Logger, browserFetcher?: BrowserPageFetcher) {
    return tool(
        async ({ urls }): Promise<WebsiteResultEntry[]> => {
            // Deduplicate URLs to avoid redundant fetches
            const unique = [...new Set(urls)];
            logger.debug({ urls: unique }, "Fetching websites");

            const results = await Promise.allSettled(
                unique.map(async (url): Promise<WebsiteResult> => {
                    const pageContents = await retrievePage(url, logger, browserFetcher);
                    return { url, pageContents };
                }),
            );

            return results.map((result, i) => {
                if (result.status === "fulfilled") {
                    return result.value;
                }
                const url = unique[i] ?? "unknown";
                const failure = toWebsiteError(url, result.reason);
                logger.warn({ url, reason: failure.reason, error: failure.error }, "Failed to fetch URL");
                return failure;
            });
        },
        {
            name: "get_website",
            description:
                "Fetch one or more web page URLs and return their full content as Markdown. " +
                "Use this when the user provides URLs to web pages they want analyzed, summarized, or referenced. " +
                "Failed entries include a reason (e.g. blocked, paywalled) that should be relayed to the user.",
            schema: z.object({
                urls: z.array(z.url()).min(1).describe("List of URLs to fetch"),
            }),
        },
    );
}

export type GetWebsiteTool = ReturnType<typeof createGetWebsiteTool>;
