import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import { BASE_USER_FACING_PROMPT, SYSTEM_PROMPT_FOOTER } from "./basePrompt.ts";

/**
 * System prompt for the search agent.
 *
 * Explicitly instructs the model to use Google Search, because Gemini decides
 * whether to invoke grounding based on prompt content — it cannot be forced programmatically.
 */
export const SEARCH_SYSTEM_PROMPT =
    BASE_USER_FACING_PROMPT +
    "\n" +
    "If the user asks a question that may require information that's more recent than January 2025, use Google Search to search the web for relevant information to answer the question.\n" +
    "Also use Google Search if the user asks a niche question that may not be answerable with your base knowledge." +
    SYSTEM_PROMPT_FOOTER;

/** Dependencies for constructing a search model provider instance. */
interface SearchModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeThoughts: boolean;
}

/**
 * Creates the search agent model with Gemini's native Google Search grounding enabled.
 *
 * Google Search grounding is bound as a built-in tool understood by the Gemini API,
 * not as a custom LangChain tool. The model uses it autonomously when the prompt
 * instructs it to search.
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
        thinkingConfig: {
            thinkingLevel: "HIGH" satisfies ThinkingLevel,
            includeThoughts: options.includeThoughts,
        },
        callbacks: sentryCallback,
    });

    // Bind the native Google Search grounding tool — this uses Gemini's built-in
    // search capability rather than a custom web search implementation.
    // NOTE: tool_choice only affects standard tools, not google-specific provider tools which is invoked
    // and enriches the response regardless of the setting
    return llm.bindTools([{ googleSearch: {} }], { tool_choice: "none" });
}

export type SearchModel = ReturnType<typeof createSearchModel>;

/**
 * Lazy-caching provider for the search model.
 *
 * Builds one {@link SearchModel} per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class SearchModelProvider extends ModelProvider<SearchModel> {
    constructor(private readonly options: SearchModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string): SearchModel {
        return createSearchModel(apiKey, modelName, this.options);
    }
}
