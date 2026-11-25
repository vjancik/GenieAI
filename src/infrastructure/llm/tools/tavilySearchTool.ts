import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Logger } from "../../../application/types/Logger.ts";
import { ToolName } from "../../../application/types/ToolName.ts";
import type { KeyRotatingTavilySearch } from "../../search/KeyRotatingTavilySearch.ts";

export const TavilySearchResultSchema = z.object({
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
 * Safely parses a raw Tavily response body, returning it together with the Zod parse result.
 * Only the results array is required — metadata fields are optional so a partial response
 * still succeeds. The caller receives the raw object regardless of parse success so the tool
 * result can still be forwarded to the LLM; grounding sources should only be populated on success.
 */
export function safeParseTavilyResponse(raw: unknown) {
    return { objResponse: raw, parsed: TavilySearchResponseResultsSchema.safeParse(raw) };
}

/**
 * Reduces a raw Tavily response to its results array, which is all the rest of the application
 * consumes: the model reads it as context and the grounding sources are derived from it.
 *
 * A response that doesn't match the expected schema is reported and still forwarded as far as
 * possible, so the model gets whatever Tavily returned.
 *
 * @param raw - The raw Tavily response body
 * @param logger - Used to report responses that don't match the expected schema
 * @returns The untouched results array, or the whole response when it has no such array
 */
export function extractTavilyResults(raw: unknown, logger: Logger): unknown {
    const { objResponse, parsed } = safeParseTavilyResponse(raw);
    if (!parsed.success) {
        logger.warn(
            { error: parsed.error.message },
            "Tavily response did not match expected schema — grounding sources will be omitted",
        );
    }

    const hasResults = typeof objResponse === "object" && objResponse !== null && "results" in objResponse;
    return hasResults ? objResponse.results : objResponse;
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

/**
 * Removes grounding chunks whose URL already appeared, keeping the first occurrence. Needed when
 * chunks from several searches are combined, as their results can overlap.
 *
 * @param chunks - Grounding chunks, in display order
 */
export function dedupeGroundingChunks(chunks: WebGroundingChunk[]): WebGroundingChunk[] {
    const seenUris = new Set<string>();
    return chunks.filter(({ web: { uri } }) => {
        if (seenUris.has(uri)) return false;
        seenUris.add(uri);
        return true;
    });
}

/**
 * Builds the grounding chunks for an answer based on one or more web searches, in the Google
 * Search shape so source formatting stays provider-agnostic.
 *
 * Result sets that don't match the expected schema contribute no sources. Searches can overlap,
 * so a source found by more than one of them is listed once.
 *
 * @param resultSets - The results of each search, as produced by the Tavily tool
 * @param logger - Logger used to report skipped results
 * @returns The deduplicated chunks, or null when no result set matched the expected schema
 */
export function searchResultsToGroundingChunks(resultSets: unknown[], logger: Logger): WebGroundingChunk[] | null {
    const parsedSets = resultSets.flatMap((resultSet) => {
        const parsed = z.array(TavilySearchResultSchema).safeParse(resultSet);
        return parsed.success ? [parsed.data] : [];
    });
    if (parsedSets.length === 0) return null;

    return dedupeGroundingChunks(parsedSets.flatMap((results) => tavilyResultsToGroundingChunks(results, logger)));
}

const TAVILY_SEARCH_DESCRIPTION =
    "Use this tool when the question requires " +
    "up-to-date information, current events, recent news, live data, or " +
    "niche topics where web search would significantly improve accuracy. " +
    "You must not call this tool with the same query more than once.";

const QUERY_DESCRIPTION = "A one sentence natural language search query that can span multiple topics.";

/** Runs a web search, resolving to the raw response body. */
type WebSearch = Pick<KeyRotatingTavilySearch, "search">;

/**
 * Creates the web search LangChain tool, exposing a simple { query } schema.
 * Resolves to the search's results array (see {@link extractTavilyResults}), so like every other
 * tool it yields a plain serializable result. Search failures are thrown, not returned as a result.
 *
 * @param logger - Used to report responses that don't match the expected schema
 * @param search - Runs the search, e.g. with key rotation
 */
export function createTavilyTool(logger: Logger, search: WebSearch) {
    return tool(async ({ query }) => extractTavilyResults(await search.search(query), logger), {
        name: ToolName.WEB_SEARCH,
        description: TAVILY_SEARCH_DESCRIPTION,
        schema: z.object({
            query: z.string().describe(QUERY_DESCRIPTION),
        }),
    });
}
