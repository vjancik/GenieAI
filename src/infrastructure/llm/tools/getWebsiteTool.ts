import { tool } from "@langchain/core/tools";
import TurndownService from "turndown";
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

const turndown = new TurndownService();
turndown.remove("script");
turndown.remove("style");
// Strip href/src from links and media to keep output concise — only preserve visible text
turndown.addRule("linksWithoutHrefs", {
    filter: ["a", "img", "video", "audio"],
    replacement: (_content, node) => {
        const text = node.textContent?.trim();
        return text ? `[${text}]()` : "";
    },
});

/**
 * Fetches a URL and returns its body as text, enforcing that the
 * Content-Type is a text/* MIME type. Non-text responses (images,
 * binaries, etc.) are rejected with a ToolError.
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

    if (!mimeType.startsWith("text/")) {
        throw new ToolError(`Unsupported content type "${mimeType}" — only text/* responses are supported`);
    }

    const body = await res.text();
    return { body, contentType: mimeType };
}

/**
 * Converts a fetched page body to a readable string for the LLM:
 * - text/html → converted to Markdown via Turndown
 * - other text/* → returned as-is (plain text, JSON, CSV, etc.)
 */
export function bodyToContent(body: string, contentType: string): string {
    if (contentType === "text/html") {
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
