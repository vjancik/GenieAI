import * as Sentry from "@sentry/bun";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import { buildRetrievedContextHints, type RetrievedContextHints, SYSTEM_PROMPT_FOOTER } from "./basePrompt.ts";
import { blockNoneSafetySettings, noInternalRetries } from "./sharedGeminiSettings.ts";
import { ValidatedChatGoogle } from "./ValidatedChatGoogle.ts";

/**
 * Builds the system prompt for the Google Search agent.
 * Injects the current date so the model can reason correctly about relative time expressions.
 *
 * Explicitly instructs the model to use Google Search, because Gemini decides whether to invoke
 * grounding based on prompt content — it cannot be forced programmatically.
 *
 * @param hints - What the tools of the turn retrieved, see {@link buildRetrievedContextHints}
 */
export function buildGoogleSearchSystemPrompt(basePrompt: string, hints: RetrievedContextHints = {}): string {
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
        buildRetrievedContextHints(hints) +
        "If the user asks a question that may require information that's more recent than January 2025, use Google Search to search the web for relevant information to answer the question.\n" +
        "Also use Google Search if the user asks a niche question that may not be answerable with your base knowledge." +
        SYSTEM_PROMPT_FOOTER
    );
}

/** Dependencies for constructing a Google Search model provider instance. */
interface GoogleSearchModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeThoughts: boolean;
}

/**
 * Creates the Google Search agent model: a Gemini model with the native Google Search grounding
 * tool bound, which it invokes autonomously when the prompt instructs it to search.
 *
 * Only used in Google search mode. In Tavily mode, searches run as a regular tool and the
 * general model answers from their results.
 */
function createGoogleSearchModel(
    apiKey: string,
    modelName: string,
    options: Omit<GoogleSearchModelOptions, "modelName" | "fallbackModelName">,
) {
    // automatic Sentry instrumentation doesn't work in Bun
    const sentryCallback =
        process.versions.bun && process.env.SENTRY_INITIALIZED ? [Sentry.createLangChainCallbackHandler()] : undefined;

    const llm = new ValidatedChatGoogle({
        model: modelName,
        apiKey,
        outputVersion: "v0",
        thinkingConfig: {
            thinkingLevel: "HIGH" satisfies ThinkingLevel,
            includeThoughts: options.includeThoughts,
        },
        safetySettings: blockNoneSafetySettings,
        callbacks: sentryCallback,
        maxRetries: noInternalRetries,
    });

    // Bind the native Google Search grounding tool — this uses Gemini's built-in
    // search capability rather than a custom web search implementation.
    // `tool_choice` is omitted: ValidatedChatGoogle replaces the derived toolConfig wholesale
    // with VALIDATED mode.
    // NOTE: functionCallingConfig only affects standard tools, not google-specific provider
    // tools, which are invoked and enrich the response regardless of the mode.
    return llm.bindTools([{ googleSearch: {} }]);
}

/**
 * Lazy-caching provider for the Google Search model.
 *
 * Builds one model per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class GoogleSearchModelProvider extends ModelProvider {
    constructor(private readonly options: GoogleSearchModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string) {
        return createGoogleSearchModel(apiKey, modelName, this.options);
    }
}
