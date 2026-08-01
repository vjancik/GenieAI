import { tool } from "@langchain/core/tools";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "zod";
import { parseMimeType } from "../../../application/helpers/parseMimeType.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { ToolError } from "../../../domain/errors/AppError.ts";

/**
 * Browser-like request headers to improve compatibility with sites that
 * block bots or return degraded responses to unrecognized user agents.
 */
const BROWSER_HEADERS: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-encoding": "gzip, deflate",
    dnt: "1",
    priority: "u=0, i",
    "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
};

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
 * Fetches a URL and returns its body as text, enforcing that the Content-Type
 * is textual (see {@link isTextualMimeType}). Binary responses (images,
 * archives, etc.) are rejected with a ToolError.
 */
export async function fetchTextBody(url: string): Promise<{ body: string; contentType: string }> {
    const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
        throw new ToolError(`HTTP ${res.status}`);
    }

    const mimeType = parseMimeType(res.headers.get("content-type")) ?? "";

    if (!isTextualMimeType(mimeType)) {
        throw new ToolError(`Unsupported content type "${mimeType}" — only textual responses are supported`);
    }

    const body = await res.text();
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
