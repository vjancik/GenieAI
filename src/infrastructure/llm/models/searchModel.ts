import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import type { GeminiApiKey } from "../../../domain/message/GeminiApiKey.ts";
import { ModelProvider } from "../ModelProvider.ts";

/**
 * System prompt for the search agent.
 *
 * Explicitly instructs the model to use Google Search, because Gemini decides
 * whether to invoke grounding based on prompt content — it cannot be forced programmatically.
 */
export const SEARCH_SYSTEM_PROMPT =
    "If the user asks a question that may require information that's more recent than January 2025, use Google Search to search the web for relevant information to answer the question.\n" +
    "Also use Google Search if the user asks a niche question that may not be answerable with your base knowledge.\n" +
    "Your answers should be shorter than 1500 characters.";

/** Dependencies for constructing a search model provider instance. */
interface SearchModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeLLMThoughts: boolean;
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
            includeThoughts: options.includeLLMThoughts,
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
 * Provider for the search model, always bound to a single paid API key.
 *
 * Google Search grounding is a paid-only feature, so the key is fixed at
 * construction time rather than being supplied per call. The `key` argument
 * to {@link get} and {@link getFallback} is accepted but ignored — the paid
 * key baked in at construction is always used.
 */
export class SearchModelProvider extends ModelProvider<SearchModel> {
    private readonly paidApiKey: string;
    private readonly includeLLMThoughts: boolean;

    constructor(apiKey: string, options: SearchModelOptions) {
        super(options.modelName, options.fallbackModelName);
        this.paidApiKey = apiKey;
        this.includeLLMThoughts = options.includeLLMThoughts;
    }

    protected create(_apiKey: string, modelName: string): SearchModel {
        // _apiKey is ignored — the search model always uses the paid key from the constructor.
        return createSearchModel(this.paidApiKey, modelName, { includeLLMThoughts: this.includeLLMThoughts });
    }

    /** Returns the primary search model (key argument ignored — paid key always used). */
    override get(_key: GeminiApiKey): SearchModel {
        return this.getOrCreate(this.paidApiKey, this.modelName);
    }

    /** Returns the fallback search model (key argument ignored — paid key always used). */
    override getFallback(_key: GeminiApiKey): SearchModel | undefined {
        if (!this.fallbackModelName) return undefined;
        return this.getOrCreate(this.paidApiKey, this.fallbackModelName);
    }
}
