import { tool } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import { z } from "zod/v4";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import type { GetVideoCaptionsTool } from "../tools/getVideoCaptionsTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";

/**
 * Sentinel tool that signals routing to the search agent.
 * The triage model calls this when the user's question needs up-to-date information.
 */
const routeToSearchTool = tool(async () => JSON.stringify({ route: "search" }), {
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
 * System prompt for the triage agent.
 * Instructs the model to classify and route — not to answer directly.
 */
export const TRIAGE_SYSTEM_PROMPT =
    "You are a routing assistant. Your ONLY job is to classify the user's message " +
    "and call exactly one of the available tools to route or handle it. " +
    "Do NOT answer the user directly — always call a tool. " +
    "Rules:\n" +
    "- If the message contains web page URLs to analyze: call get_website\n" +
    "- If the message contains video URLs (YouTube, social media, etc.): call get_video_captions\n" +
    "- If the question needs current/live information or very niche topics: call route_to_search\n" +
    "- For everything else: call route_to_general";

/** Dependencies for constructing a triage model provider instance. */
interface TriageModelOptions {
    /** Gemini model identifier (e.g. "gemini-3-flash-preview"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Gemini reasoning effort level (e.g. "MINIMAL", "MEDIUM", "HIGH"). */
    triageThinkingLevel: ThinkingLevel;
    /** Whether to include thought tokens in the model response. */
    includeLLMThoughts: boolean;
    getWebsiteTool: GetWebsiteTool;
    getVideoCaptionsTool: GetVideoCaptionsTool;
}

/**
 * Creates the triage model with all four routing tools bound.
 *
 * The triage model is invoked with a single-pass (no ReAct loop) — the orchestrator
 * inspects the tool call from the response and routes accordingly.
 *
 * Uses a low thinking budget to keep latency and cost minimal for classification.
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
            thinkingLevel: options.triageThinkingLevel,
            includeThoughts: options.includeLLMThoughts,
        },
        callbacks: sentryCallback,
    });

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
