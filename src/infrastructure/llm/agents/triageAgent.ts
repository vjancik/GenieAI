import { tool } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google";
import { z } from "zod/v4";
import type { AppConfig } from "../../config/config.ts";
import type { GetVideoTranscriptionTool } from "../tools/getVideoTranscriptionTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";

/**
 * Sentinel tool that signals routing to the search agent.
 * The triage model calls this when the user's question needs up-to-date information.
 */
const routeToSearchTool = tool(
    async () => JSON.stringify({ route: "search" }),
    {
        name: "route_to_search",
        description:
            "Route to a search-capable agent. Use this when the question requires " +
            "up-to-date information, current events, recent news, live data, or " +
            "niche topics where web search would significantly improve accuracy.",
        schema: z.object({}),
    },
);

/**
 * Sentinel tool that signals routing to the general-purpose agent.
 * Used for everything that doesn't need websites, video transcriptions, or search.
 */
const routeToGeneralTool = tool(
    async () => JSON.stringify({ route: "general" }),
    {
        name: "route_to_general",
        description:
            "Route to the general-purpose agent for all other questions: " +
            "creative writing, coding, math, general knowledge, explanations, " +
            "and anything that doesn't require real-time data or external content.",
        schema: z.object({}),
    },
);

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
    "- If the message contains video URLs (YouTube, social media, etc.): call get_video_transcription\n" +
    "- If the question needs current/live information or very niche topics: call route_to_search\n" +
    "- For everything else: call route_to_general";

export interface TriageAgentDeps {
    config: AppConfig;
    getWebsiteTool: GetWebsiteTool;
    getVideoTranscriptionTool: GetVideoTranscriptionTool;
}

/**
 * Creates the triage model with all four routing tools bound.
 *
 * The triage model is invoked with a single-pass (no ReAct loop) — the orchestrator
 * inspects the tool call from the response and routes accordingly.
 *
 * Uses a low thinking budget to keep latency and cost minimal for classification.
 */
export function createTriageModel({
    config,
    getWebsiteTool,
    getVideoTranscriptionTool,
}: TriageAgentDeps) {
    const llm = new ChatGoogle({
        model: "gemini-3.1-flash-lite-preview",
        apiKey: config.googleApiKey,
        thinkingConfig: {
            thinkingLevel: config.triageThinkingLevel,
            includeThoughts: config.includeLLMThoughts,
        },
    });

    const tools = [
        getWebsiteTool,
        getVideoTranscriptionTool,
        routeToSearchTool,
        routeToGeneralTool,
    ];
    return llm.bindTools(tools);
}

export type TriageModel = ReturnType<typeof createTriageModel>;
