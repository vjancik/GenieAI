import { tool } from "@langchain/core/tools";
import TurndownService from "turndown";
import { z } from "zod/v4";
import { ToolError } from "../../../domain/errors/AppError.ts";
import type { Logger } from "../../logging/logger.ts";

/**
 * Creates a LangChain tool that fetches one or more URLs and returns their
 * content converted to Markdown.
 *
 * Duplicate URLs are deduplicated before fetching. Individual URL failures
 * are handled gracefully — the error is included inline in the result
 * so the LLM is aware of what could not be retrieved.
 *
 * @param logger - Injectable logger for testability
 */
export function createGetWebsiteTool(logger: Logger) {
    const turndown = new TurndownService();

    return tool(
        async ({ urls }) => {
            // Deduplicate URLs to avoid redundant fetches
            const unique = [...new Set(urls)];
            logger.debug({ urls: unique }, "Fetching websites");

            const results = await Promise.allSettled(
                unique.map(async (url) => {
                    const res = await fetch(url);
                    if (!res.ok) {
                        throw new ToolError(
                            `HTTP ${res.status} fetching ${url}`,
                        );
                    }
                    const html = await res.text();
                    const markdown = turndown.turndown(html);
                    return `## ${url}\n\n${markdown}`;
                }),
            );

            return results
                .map((result, i) => {
                    if (result.status === "fulfilled") {
                        return result.value;
                    }
                    const err = result.reason as Error;
                    logger.warn(
                        { url: unique[i], error: err.message },
                        "Failed to fetch URL",
                    );
                    return `## ${unique[i]}\n\nError: ${err.message}`;
                })
                .join("\n\n---\n\n");
        },
        {
            name: "get_website",
            description:
                "Fetch one or more web page URLs and return their full content as Markdown. " +
                "Use this when the user provides URLs to web pages they want analyzed, summarized, or referenced.",
            schema: z.object({
                urls: z
                    .array(z.string().url())
                    .min(1)
                    .describe("List of URLs to fetch"),
            }),
        },
    );
}

export type GetWebsiteTool = ReturnType<typeof createGetWebsiteTool>;
