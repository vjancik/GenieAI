import { tool } from "@langchain/core/tools";
import { Impit } from "impit";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "zod";
import { parseMimeType } from "../../../application/helpers/parseMimeType.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { ToolError } from "../../../domain/errors/AppError.ts";

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

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
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
 * Fetches a URL and returns its body as text, enforcing that the Content-Type
 * is textual (see {@link isTextualMimeType}). Binary responses (images,
 * archives, etc.) are rejected with a ToolError.
 *
 * Requests go through Impit's Firefox preset rather than the platform `fetch`.
 * Many publishers reject requests by TLS/HTTP2 fingerprint regardless of how
 * browser-like the headers are, which `fetch` cannot work around.
 *
 * GDPR consent interstitials encountered along the way are accepted
 * automatically (see {@link acceptConsentForm}).
 */
export async function fetchTextBody(url: string): Promise<{ body: string; contentType: string }> {
    const impit = new Impit({
        browser: "firefox",
        followRedirects: true,
        maxRedirects: MAX_REDIRECTS,
        timeout: REQUEST_TIMEOUT_MS,
        cookieJar: createCookieJar(),
        headers: CONTENT_HEADERS,
    });

    const res = await impit.fetch(url);

    if (!res.ok) {
        throw new ToolError(`HTTP ${res.status}`);
    }

    const mimeType = parseMimeType(res.headers.get("content-type")) ?? "";

    if (!isTextualMimeType(mimeType)) {
        throw new ToolError(`Unsupported content type "${mimeType}" — only textual responses are supported`);
    }

    const body = await res.text();

    if (HTML_MIME_TYPES.has(mimeType) && CONSENT_FORM_PATTERN.test(body)) {
        const consented = await acceptConsentForm(impit, res.url, body);
        if (consented !== null) return { body: consented, contentType: mimeType };
    }

    return { body, contentType: mimeType };
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
/** Error result for a single URL fetch. */
export type WebsiteError = { url: string; error: string };
/** Union result type returned per URL by the website tool. */
export type WebsiteResultEntry = WebsiteResult | WebsiteError;

/**
 * Creates a LangChain tool that fetches one or more URLs and returns their
 * content as a structured array, one entry per URL. HTML pages are converted
 * to Markdown; other text/* types are returned verbatim. Non-text content
 * types are rejected. Individual URL failures are co-located with the URL
 * in an error entry so the LLM knows what could not be retrieved.
 *
 * Duplicate URLs are deduplicated before fetching.
 *
 * @param logger - Injectable logger for testability
 */
export function createGetWebsiteTool(logger: Logger) {
    return tool(
        async ({ urls }): Promise<WebsiteResultEntry[]> => {
            // Deduplicate URLs to avoid redundant fetches
            const unique = [...new Set(urls)];
            logger.debug({ urls: unique }, "Fetching websites");

            const results = await Promise.allSettled(
                unique.map(async (url): Promise<WebsiteResult> => {
                    const { body, contentType } = await fetchTextBody(url);
                    const pageContents = bodyToContent(body, contentType);
                    return { url, pageContents };
                }),
            );

            return results.map((result, i) => {
                if (result.status === "fulfilled") {
                    return result.value;
                }
                const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
                const url = unique[i] ?? "unknown";
                logger.warn({ url, error: err.message }, "Failed to fetch URL");
                return { url, error: `Failed to retrieve the contents of ${url}` };
            });
        },
        {
            name: "get_website",
            description:
                "Fetch one or more web page URLs and return their full content as Markdown. " +
                "Use this when the user provides URLs to web pages they want analyzed, summarized, or referenced.",
            schema: z.object({
                urls: z.array(z.url()).min(1).describe("List of URLs to fetch"),
            }),
        },
    );
}

export type GetWebsiteTool = ReturnType<typeof createGetWebsiteTool>;
