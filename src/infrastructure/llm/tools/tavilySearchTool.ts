import { tool } from "@langchain/core/tools";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";
import type { Logger } from "../../../application/types/Logger.ts";

const TavilySearchResultSchema = z.object({
    url: z.string(),
    title: z.string(),
    content: z.string(),
    score: z.number().optional(),
    raw_content: z.string().nullish(),
});

const TavilySearchResponseResultsSchema = z.object({
    results: z.array(TavilySearchResultSchema),
});

// const TavilySearchResponseOptionalMetadataSchema = z.object({
//     query: z.string().optional(),
//     follow_up_questions: z.unknown().optional().nullish(),
//     answer: z.string().optional().nullish(),
//     images: z.array(z.unknown()).optional(),
//     response_time: z.number().optional(),
//     usage: z.record(z.string(), z.unknown()).optional(),
//     request_id: z.string().optional(),
// });

// const TavilySearchResponseSchema = TavilySearchResponseResultsSchema.extend(
//     TavilySearchResponseOptionalMetadataSchema.shape,
// );

// export type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;
// export type TavilySearchResponse = z.infer<typeof TavilySearchResponseSchema>;

/**
 * Safely parses a raw Tavily invoke result (which may be a pre-parsed object or a JSON string).
 * Returns the normalised object and the Zod parse result.
 * Only the results array is required — metadata fields are optional so a partial response
 * still succeeds. The caller receives the raw object regardless of parse success so the tool
 * result can still be forwarded to the LLM; grounding sources should only be populated on success.
 */
export function safeParseTavilyResponse(raw: unknown) {
    const objResponse = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { objResponse, parsed: TavilySearchResponseResultsSchema.safeParse(objResponse) };
}

type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

/** A grounding chunk in the Google Search shape, so source formatting stays provider-agnostic. */
type WebGroundingChunk = { web: { uri: string; title: string } };

/**
 * Extracts the bare hostname (minus a leading `www.`) from an absolute http(s) URL.
 *
 * Returns `null` for anything that cannot be used as a citation link: relative
 * references (which have no origin to resolve against), malformed values, and
 * non-http(s) schemes such as `javascript:` — the latter parse successfully but
 * must never be rendered into a Discord markdown link.
 */
function citationHostname(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname === "") return null;

    return parsed.hostname.replace(/^www\./, "");
}

/**
 * Converts Tavily search results into Google-Search-shaped grounding chunks,
 * using each result's hostname as the display title.
 *
 * Tavily sometimes returns a `url` that is not an absolute URL — most commonly a
 * relative redirect path such as `/goto?url=<opaque-token>` leaked from a proxied
 * result page. There is no origin to resolve such a path against and the token is
 * an opaque server-side blob, so the destination is unrecoverable; those results
 * are skipped rather than rendered as a broken source link. This only affects the
 * citation list — the result content is still forwarded to the model separately.
 *
 * @param results - Successfully parsed Tavily search results
 * @param logger - Logger used to report skipped results
 */
export function tavilyResultsToGroundingChunks(results: TavilySearchResult[], logger: Logger): WebGroundingChunk[] {
    const chunks: WebGroundingChunk[] = [];
    const skippedUrls: string[] = [];

    for (const result of results) {
        const hostname = citationHostname(result.url);
        if (hostname === null) {
            skippedUrls.push(result.url);
            continue;
        }
        chunks.push({ web: { uri: result.url, title: hostname } });
    }

    if (skippedUrls.length > 0) {
        logger.warn({ skippedUrls }, "Tavily returned unusable result URLs — omitting them from the grounding sources");
    }

    return chunks;
}

const TAVILY_SEARCH_NAME = "web_search";
const TAVILY_SEARCH_DESCRIPTION =
    "Use this tool when the question requires " +
    "up-to-date information, current events, recent news, live data, or " +
    "niche topics where web search would significantly improve accuracy. " +
    "You must not call this tool with the same query more than once.";

const QUERY_DESCRIPTION = "A one sentence natural language search query that can span multiple topics.";

/**
 * Creates a LangChain tool that wraps TavilySearch and exposes a simple { query } schema.
 * Must only be called when TAVILY_API_KEY is set.
 */
export function createTavilyTool() {
    const inner = new TavilySearch({
        maxResults: 10,
        includeUsage: true,
        responseFormat: "content",
        searchDepth: "advanced",
        chunksPerSource: 3,
        includeAnswer: false,
        includeFavicon: false,
        includeImages: false,
        includeImageDescriptions: false,
        // TODO: debug env var
        verbose: false,
    });

    return tool(({ query }) => inner.invoke({ query }), {
        name: TAVILY_SEARCH_NAME,
        description: TAVILY_SEARCH_DESCRIPTION,
        schema: z.object({
            query: z.string().describe(QUERY_DESCRIPTION),
        }),
    });
}

// export type TavilyTool = ReturnType<typeof createTavilyTool>;
