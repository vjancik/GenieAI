import { tool } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import { z } from "zod/v4";
import { SearchMode } from "../../../application/config/AppConfig.ts";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import type { GetVideoCaptionsTool } from "../tools/getVideoCaptionsTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";
import { blockNoneSafetySettings } from "./sharedGeminiSettings.ts";

const ROUTE_TO_SEARCH_NAME = "route_to_search";
const ROUTE_TO_SEARCH_DESCRIPTION =
    "Route to a search-capable agent. Use this when the question requires " +
    "up-to-date information, current events, recent news, live data, or " +
    "niche topics where web search would significantly improve accuracy.";

/**
 * Sentinel tool that signals routing to the Google Search agent.
 * The triage model calls this when the user's question needs up-to-date information.
 * Google Search grounding is handled by the search model itself — no query needed here.
 */
const routeToGoogleSearchTool = tool(async () => JSON.stringify({ route: "search" }), {
    name: ROUTE_TO_SEARCH_NAME,
    description: ROUTE_TO_SEARCH_DESCRIPTION,
    schema: z.object({}),
});

/**
 * Sentinel tool that signals routing to the Tavily Search agent.
 * Requires a pre-formed query so the orchestrator can pass it directly to the Tavily API.
 */
const routeToTavilySearchTool = tool(async () => JSON.stringify({ route: "search" }), {
    name: ROUTE_TO_SEARCH_NAME,
    description: ROUTE_TO_SEARCH_DESCRIPTION,
    schema: z.object({
        query: z.string().min(1).describe("A one sentence natural language query that can span multiple topics."),
    }),
});

/**
 * Sentinel tool that signals routing to the general-purpose agent.
 * Used for everything that doesn't need websites, video captions, or search.
 */
const routeToGeneralTool = tool(async () => JSON.stringify({ route: "general" }), {
    name: "route_to_general",
    description:
        "Route to the general-purpose agent for all other questions: " +
        "creative writing, coding, math, general knowledge, explanations, " +
        "and anything that doesn't require real-time data or external content.",
    schema: z.object({}),
});

/**
 * System prompt for the triage agent.
 * Instructs the model to classify and route — not to answer directly.
 */
export const TRIAGE_SYSTEM_PROMPT =
    "You are a request analysis agent. Your job is to intelligently respond to the user's message with the right " +
    "tools and call exactly one route tool to route the request to another agent or one or more data retrieval " +
    "tools to retrieve the necessary information to satisfy the request." +
    "Rules:\n" +
    "- If the message contains web page URLs to analyze: call get_website\n" +
    "- If the message contains video URLs (YouTube, social media, etc.): call get_video_captions\n" +
    "- You should only use URLs present in the user's message — do not make assumptions or add new URLs on your own\n" +
    "- If the question needs current/live information or very niche topics: call route_to_search\n" +
    "- For everything else: call route_to_general";

/** Dependencies for constructing a triage model provider instance. */
interface TriageModelOptions {
    /** Gemini model identifier (e.g. "gemini-3-flash-preview"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Gemini reasoning effort level (e.g. "MINIMAL", "MEDIUM", "HIGH"). */
    thinkingLevel: ThinkingLevel;
    /** Whether to include thought tokens in the model response. */
    includeThoughts: boolean;
    /** Which search backend is active — determines which route_to_search tool is bound. */
    searchMode: SearchMode;
    getWebsiteTool: GetWebsiteTool;
    getVideoCaptionsTool: GetVideoCaptionsTool;
}

/**
 * Creates the triage model with all routing tools bound.
 *
 * The triage model is invoked with a single-pass (no ReAct loop) — the orchestrator
 * inspects the tool call from the response and routes accordingly.
 *
 * Uses a low thinking budget to keep latency and cost minimal for classification.
 * The search routing tool is selected based on `searchMode`: Google grounding needs no
 * query (the search model handles it), while Tavily requires a pre-formed query string.
 */
function createTriageModel(
    apiKey: string,
    modelName: string,
    options: Omit<TriageModelOptions, "modelName" | "fallbackModelName">,
) {
    // automatic Sentry instrumentation doesn't work in Bun
    const sentryCallback =
        process.versions.bun && process.env.SENTRY_INITIALIZED ? [Sentry.createLangChainCallbackHandler()] : undefined;

    const llm = new ChatGoogle({
        model: modelName,
        apiKey,
        thinkingConfig: {
            thinkingLevel: options.thinkingLevel,
            includeThoughts: options.includeThoughts,
        },
        safetySettings: blockNoneSafetySettings,
        callbacks: sentryCallback,
    });

    const routeToSearchTool =
        options.searchMode === SearchMode.tavily ? routeToTavilySearchTool : routeToGoogleSearchTool;

    const tools = [options.getWebsiteTool, options.getVideoCaptionsTool, routeToSearchTool, routeToGeneralTool];
    return llm.bindTools(tools, { tool_choice: "any" });
}

export type TriageModel = ReturnType<typeof createTriageModel>;

/**
 * Lazy-caching provider for the triage model.
 *
 * Builds one {@link TriageModel} per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class TriageModelProvider extends ModelProvider<TriageModel> {
    constructor(private readonly options: TriageModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string): TriageModel {
        return createTriageModel(apiKey, modelName, this.options);
    }
}
