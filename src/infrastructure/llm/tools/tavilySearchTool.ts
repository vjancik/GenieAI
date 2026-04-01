import { tool } from "@langchain/core/tools";
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
