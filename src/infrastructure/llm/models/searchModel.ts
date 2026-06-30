import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import { SearchMode } from "../../../application/config/AppConfig.ts";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import { SYSTEM_PROMPT_FOOTER } from "./basePrompt.ts";
import { blockHighSafetySettings, neverTool } from "./sharedGeminiSettings.ts";

/**
 * Builds the system prompt for the search agent.
 * Injects the current date so the model can reason correctly about relative time expressions.
 *
 * In Google mode, also explicitly instructs the model to use Google Search, because Gemini
 * decides whether to invoke grounding based on prompt content — it cannot be forced programmatically.
 * In Tavily mode, search results are pre-injected as tool messages so no search instruction is needed.
 *
 * @param searchMode - Determines whether Google Search instructions are included
 */
export function buildSearchSystemPrompt(basePrompt: string, searchMode: SearchMode): string {
    const dateStr = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    return (
        basePrompt +
        "\n" +
        `You should assume the current date is ${dateStr}. Do not mention the date unless the user asks about it.\n` +
        (searchMode === SearchMode.google
            ? "If the user asks a question that may require information that's more recent than January 2025, use Google Search to search the web for relevant information to answer the question.\n" +
              "Also use Google Search if the user asks a niche question that may not be answerable with your base knowledge."
            : "YOU MUST NOT INVOKE ANY TOOLS OR FUNCTIONS. Answer the query with the available information.") +
        SYSTEM_PROMPT_FOOTER
    );
}

/** Dependencies for constructing a search model provider instance. */
interface SearchModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeThoughts: boolean;
    /** Which search backend is active — determines whether Google Search grounding is bound. */
    searchMode: SearchMode;
}

/**
 * Creates the search agent model.
 *
 * When `searchMode` is "google", binds Gemini's native Google Search grounding tool so
 * the model can invoke it autonomously when the prompt instructs it to search.
 * When `searchMode` is "tavily", the Tavily tool is injected by the orchestrator instead,
 * so the model is returned as a plain LLM without any bound tools.
 */
function createSearchModel(
    apiKey: string,
    modelName: string,
    options: Omit<SearchModelOptions, "modelName" | "fallbackModelName">,
) {
    // automatic Sentry instrumentation doesn't work in Bun
    const sentryCallback =
        process.versions.bun && process.env.SENTRY_INITIALIZED ? [Sentry.createLangChainCallbackHandler()] : undefined;

    const llm = new ChatGoogle({
        model: modelName,
        apiKey,
        outputVersion: "v0",
        thinkingConfig: {
            thinkingLevel: "HIGH" satisfies ThinkingLevel,
            includeThoughts: options.includeThoughts,
        },
        safetySettings: blockHighSafetySettings,
        callbacks: sentryCallback,
    });

    if (options.searchMode !== SearchMode.google) {
        // Workaround for https://github.com/langchain-ai/langchainjs/issues/10432 — tool_choice: "none" is ignored on empty arrays
        return llm.bindTools([neverTool], { tool_choice: "none" });
    } else {
        // Bind the native Google Search grounding tool — this uses Gemini's built-in
        // search capability rather than a custom web search implementation.
        // NOTE: tool_choice only affects standard tools, not google-specific provider tools which is invoked
        // and enriches the response regardless of the setting
        return llm.bindTools([{ googleSearch: {} }], { tool_choice: "none" });
    }
}

/**
 * Lazy-caching provider for the search model.
 *
 * Builds one {@link SearchModel} per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class SearchModelProvider extends ModelProvider {
    constructor(private readonly options: SearchModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string) {
        return createSearchModel(apiKey, modelName, this.options);
    }
}
