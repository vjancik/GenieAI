import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import { ModelProvider } from "../ModelProvider.ts";

/**
 * System prompt for the general-purpose agent.
 * Keeps responses within Discord's practical character limit.
 */
export const GENERAL_SYSTEM_PROMPT =
    "You are Genie, a helpful AI assistant on Discord. " +
    "Answer questions clearly, accurately, and concisely. " +
    "Keep your response under 1500 characters.";

/** Dependencies for constructing a general model provider instance. */
interface GeneralModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeLLMThoughts: boolean;
}

/**
 * Creates the general-purpose model — the stronger Gemini model used for
 * all non-search routes, including evaluating web page and video tool results.
 */
function createGeneralModel(
    apiKey: string,
    modelName: string,
    options: Omit<GeneralModelOptions, "modelName" | "fallbackModelName">,
) {
    // automatic Sentry instrumentation doesn't work in Bun
    const sentryCallback =
        process.versions.bun && process.env.SENTRY_INITIALIZED ? [Sentry.createLangChainCallbackHandler()] : undefined;

    return new ChatGoogle({
        model: modelName,
        apiKey,
        thinkingConfig: {
            thinkingLevel: "high",
            includeThoughts: options.includeLLMThoughts,
        },
        callbacks: sentryCallback,
    });
}

export type GeneralModel = ReturnType<typeof createGeneralModel>;

/**
 * Lazy-caching provider for the general-purpose model.
 *
 * Builds one {@link GeneralModel} per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class GeneralModelProvider extends ModelProvider<GeneralModel> {
    constructor(private readonly options: GeneralModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string): GeneralModel {
        return createGeneralModel(apiKey, modelName, this.options);
    }
}
