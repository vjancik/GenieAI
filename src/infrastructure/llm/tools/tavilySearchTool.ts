import { TavilySearch } from "@langchain/tavily";
import { z } from "zod/v4";

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

const TavilySearchResponseOptionalMetadataSchema = z.object({
    query: z.string().optional(),
    follow_up_questions: z.unknown().optional().nullish(),
    answer: z.string().optional().nullish(),
    images: z.array(z.unknown()).optional(),
    response_time: z.number().optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string().optional(),
});

const TavilySearchResponseSchema = TavilySearchResponseResultsSchema.extend(
    TavilySearchResponseOptionalMetadataSchema.shape,
);

export type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;
export type TavilySearchResponse = z.infer<typeof TavilySearchResponseSchema>;

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

const ROUTE_TO_SEARCH_NAME = "web_search";
const ROUTE_TO_SEARCH_DESCRIPTION =
    "Use this when the question requires " +
    "up-to-date information, current events, recent news, live data, or " +
    "niche topics where web search would significantly improve accuracy.\n" +
    "The input query should be a one sentence natural language query that can span multiple topics.\n" +
    "You must not call this tool with the same query more than once.";

/** Creates a TavilySearch tool instance. Must only be called when TAVILY_API_KEY is set. */
export function createTavilyTool() {
    return new TavilySearch({
        name: ROUTE_TO_SEARCH_NAME,
        description: ROUTE_TO_SEARCH_DESCRIPTION,
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
}
