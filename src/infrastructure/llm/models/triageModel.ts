import { tool } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import { z } from "zod/v4";
import { SearchMode } from "../../../application/config/AppConfig.ts";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import type { GetVideoCaptionsTool } from "../tools/getVideoCaptionsTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";
import { tool as tavilySearchTool } from "../tools/tavilySearchTool.ts";
import { blockNoneSafetySettings } from "./sharedGeminiSettings.ts";

/**
 * Sentinel tool that signals routing to the Google Search agent.
 * The triage model calls this when the user's question needs up-to-date information.
 * Google Search grounding is handled by the search model itself — no query needed here.
 */
const routeToGoogleSearchTool = tool(async () => JSON.stringify({ route: "search" }), {
    name: "route_to_search",
    description:
        "Route to a search-capable agent. Use this when the question requires " +
        "up-to-date information, current events, recent news, live data, or " +
        "niche topics where web search would significantly improve accuracy.",
    schema: z.object({}),
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
 * Builds the system prompt for the triage agent.
 * Instructs the model to classify and route — not to answer directly.
 *
 * In Tavily mode the search tool is `web_search` (the real Tavily tool bound directly);
 * in Google mode it is the `route_to_search` sentinel.
 *
 * @param searchMode - Determines the name of the search tool referenced in the prompt.
 */
export function buildTriageSystemPrompt(searchMode: SearchMode): string {
    const searchToolName = searchMode === SearchMode.tavily ? "web_search" : "route_to_search";

    return (
        "You are a request analysis agent. Your job is to intelligently respond to the user's message with the right " +
        "tools and call exactly one route tool to route the request to another agent or one or more data retrieval " +
        "tools to retrieve the necessary information to satisfy the request." +
        "Rules:\n" +
        "- If the message contains web page URLs to analyze: call get_website\n" +
        "- If the message contains video URLs (YouTube, social media, etc.): call get_video_captions\n" +
        "- You should only use URLs present in the user's message — do not make assumptions or add new URLs on your own\n" +
        "- If the question needs current/live information or very niche topics: call " +
        searchToolName +
        "\n" +
        "- For everything else: call route_to_general"
    );
}

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
    /** Which search backend is active — determines which search tool is bound. */
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
 * In Tavily mode the real `tavilySearchTool` (`web_search`) is bound directly so the
 * model calls it and the result is captured from the triage response. In Google mode
 * the `route_to_search` sentinel is bound instead and routing is handled separately.
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

    const searchTool = options.searchMode === SearchMode.tavily ? tavilySearchTool : routeToGoogleSearchTool;

    const tools = [options.getWebsiteTool, options.getVideoCaptionsTool, searchTool, routeToGeneralTool];
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
