import { tool } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { SearchMode } from "../../../application/config/AppConfig.ts";
import type { IModelTool } from "../../../application/ports/IModelTool.ts";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { RoutingSentinel, ToolName } from "../../../application/types/ToolName.ts";
import { ModelProvider } from "../ModelProvider.ts";
import type { GetVideoCaptionsTool } from "../tools/getVideoCaptionsTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";
import { blockNoneSafetySettings, noInternalRetries } from "./sharedGeminiSettings.ts";

/**
 * Sentinel tool that signals routing to the Google Search agent (Google search mode only).
 * The triage model calls this when the user's question needs up-to-date information.
 * Google Search grounding is handled by the Google Search model itself — no query needed here.
 */
const routeToGoogleSearchTool = tool(async () => JSON.stringify({ route: "search" }), {
    name: RoutingSentinel.SEARCH,
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
    name: RoutingSentinel.GENERAL,
    description:
        "Route to the general-purpose agent for: creative writing, coding questions, general knowledge, " +
        "explanations, and anything that doesn't require real-time data, external content, or Python execution.",
    schema: z.object({}),
});

/**
 * Sentinel tool that signals routing to the computation agent.
 * Used when the request requires running Python code for computation, data processing, or math.
 */
const routeToPythonTool = tool(async () => JSON.stringify({ route: "python" }), {
    name: RoutingSentinel.PYTHON,
    description:
        "Route to the Python agent. Use this when the request would benefit from executing Python code " +
        "to produce a result: numerical computation, graphing, plotting, " +
        "math problems where a calculated answer is expected, or any task that benefits from running " +
        "actual code. DO NOT call this agent for file processing as it can't load external files at " +
        "the moment.",
    schema: z.object({}),
});

/**
 * Builds the system prompt for the triage agent.
 * Instructs the model to retrieve data and route — not to answer directly.
 *
 * Data retrieval tools and a route tool can be combined: the retrieval tools run first, then
 * the routed agent answers. In Tavily mode web search is a retrieval tool (`web_search`, the real
 * Tavily tool bound directly); in Google mode it is a route (`route_to_search`), as the Google
 * Search agent does its own searching.
 *
 * @param searchMode - Determines how the prompt refers to web search
 * @param isSearchRequested - Whether the user explicitly asked for a web search. Only supported
 *   in Tavily mode, where it selects the prompt matching {@link buildSearchIntentTriageTools}.
 */
export function buildTriageSystemPrompt(searchMode: SearchMode, isSearchRequested = false): string {
    const isTavily = searchMode === SearchMode.tavily;
    const searchToolName = isTavily ? ToolName.WEB_SEARCH : RoutingSentinel.SEARCH;
    const canRouteToPython = !(isTavily && isSearchRequested);

    const retrievalTools = [ToolName.GET_WEBSITE, ToolName.GET_VIDEO_CAPTIONS, ...(isTavily ? [searchToolName] : [])];
    const routeTools = [
        ...(isTavily ? [] : [searchToolName]),
        ...(canRouteToPython ? [RoutingSentinel.PYTHON] : []),
        RoutingSentinel.GENERAL,
    ];

    return (
        "You are a request analysis agent. You never answer the user yourself, you respond only with tool calls.\n" +
        `Call the data retrieval tools (${retrievalTools.join(", ")}) needed to satisfy the request, if any. ` +
        "You may call several of them in one response.\n" +
        `Call at most one route tool (${routeTools.join(", ")}) to pick the agent that answers the request, ` +
        "which it does with the retrieved data. When you call no route tool, the general-purpose agent answers.\n" +
        "Rules:\n" +
        `- If the message contains web page URLs to analyze: call ${ToolName.GET_WEBSITE}\n` +
        `- If the message contains video URLs (YouTube, social media, etc.): call ${ToolName.GET_VIDEO_CAPTIONS}\n` +
        "- DO NOT call the previous 2 tools for the same URLs more than once\n" +
        "- You should only use URLs present in the user's message — do not add new URLs on your own\n" +
        (isSearchRequested
            ? `- The user explicitly requested a web search: call ${searchToolName}, unless a search clearly cannot contribute to the request\n`
            : `- If the question needs current/live information or is about very niche topics: call ${searchToolName}\n` +
              `- Only combine ${searchToolName} with retrieving URLs when the user asks for information beyond the linked ` +
              "content, such as a comparison with current events or a fact check. A request to summarize or explain " +
              "a link needs no search\n") +
        (canRouteToPython
            ? `- If the request requires running Python code to compute or process a result: call ${RoutingSentinel.PYTHON}\n`
            : "") +
        `- If no data needs to be retrieved and no other rule applies: call ${RoutingSentinel.GENERAL}`
    );
}

/** The tools a triage model can be bound to. */
type TriageTools = Parameters<ChatGoogle["bindTools"]>[0];

/** Dependencies for selecting the tools of the regular triage model. */
interface TriageToolsOptions {
    /** Which search backend is active — determines which search tool is bound. */
    searchMode: SearchMode;
    getWebsiteTool: GetWebsiteTool;
    getVideoCaptionsTool: GetVideoCaptionsTool;
    /** Required when searchMode is tavily — the pre-constructed Tavily search tool instance. */
    tavilyTool?: IModelTool<{ query: string }>;
}

/**
 * Selects the tools of the regular triage model: the content tools, a search tool and the
 * routing sentinels.
 *
 * In Tavily mode the real Tavily tool (`web_search`) is bound, so the model writes the search
 * query itself and the orchestrator executes the call. In Google mode the `route_to_search`
 * sentinel is bound instead, as the Google Search model does its own searching.
 */
export function buildTriageTools(options: TriageToolsOptions): TriageTools {
    // There is no Google Search agent to route to in Tavily mode
    const searchTool = options.searchMode === SearchMode.tavily ? options.tavilyTool : routeToGoogleSearchTool;

    return [
        options.getWebsiteTool,
        options.getVideoCaptionsTool,
        ...(searchTool ? [searchTool] : []),
        routeToPythonTool,
        routeToGeneralTool,
    ];
}

/**
 * Selects the tools of the triage model used in Tavily mode when the user explicitly requested
 * a web search: every data retrieval tool, and `route_to_general` as the only way to opt out.
 * Triage mainly has to write the search query here, so the other routing sentinels are left out.
 */
export function buildSearchIntentTriageTools(options: Required<Omit<TriageToolsOptions, "searchMode">>): TriageTools {
    return [options.getWebsiteTool, options.getVideoCaptionsTool, options.tavilyTool, routeToGeneralTool];
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
    /** The tools the model must choose from, see {@link buildTriageTools}. */
    tools: TriageTools;
}

/**
 * Creates a triage model with the given tools bound, forced to call at least one of them.
 *
 * The triage model is invoked with a single-pass (no ReAct loop) — the orchestrator
 * inspects the tool calls from the response and routes accordingly.
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
        outputVersion: "v0",
        thinkingConfig: {
            thinkingLevel: options.thinkingLevel,
            includeThoughts: options.includeThoughts,
        },
        safetySettings: blockNoneSafetySettings,
        callbacks: sentryCallback,
        maxRetries: noInternalRetries,
    });

    return llm.bindTools(options.tools, { tool_choice: "any" });
}

/**
 * Lazy-caching provider for a triage model.
 *
 * Builds one model per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class TriageModelProvider extends ModelProvider {
    constructor(private readonly options: TriageModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string) {
        return createTriageModel(apiKey, modelName, this.options);
    }
}
