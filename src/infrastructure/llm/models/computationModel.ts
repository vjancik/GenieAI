import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import { buildRetrievedContextHints, type RetrievedContextHints, SYSTEM_PROMPT_FOOTER } from "./basePrompt.ts";
import { blockNoneSafetySettings, noInternalRetries } from "./sharedGeminiSettings.ts";

/**
 * Builds the system prompt for the computation agent.
 * Injects the current date so the model knows its base knowledge is outdated.
 *
 * @param hints - What the tools of the turn retrieved, see {@link buildRetrievedContextHints}
 */
export function buildComputationSystemPrompt(basePrompt: string, hints: RetrievedContextHints = {}): string {
    const dateStr = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    return (
        basePrompt +
        "\n" +
        "Always report the result of your computation in text as the code output may not always be shown to the user.\n" +
        `You should assume the current date is ${dateStr} and your base knowledge is outdated by more than a year. Do not mention the date unless the user asks about it.\n` +
        buildRetrievedContextHints(hints) +
        SYSTEM_PROMPT_FOOTER
    );
}

/** Dependencies for constructing a computation model provider instance. */
interface ComputationModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeThoughts: boolean;
}

/**
 * Creates the computation model — a Gemini model with the native `codeExecution`
 * tool bound. Used for Python computation, data processing, and math-heavy requests
 * where reliable code execution is preferable to hallucinated results.
 *
 * Kept as a dedicated node (not merged into general) because Gemini is too eager to
 * invoke `codeExecution` when it is always bound, degrading general-purpose responses.
 */
function createComputationModel(
    apiKey: string,
    modelName: string,
    options: Omit<ComputationModelOptions, "modelName" | "fallbackModelName">,
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
        safetySettings: blockNoneSafetySettings,
        callbacks: sentryCallback,
        maxRetries: noInternalRetries,
    });

    return llm.bindTools([{ codeExecution: {} }]);
}

/**
 * Lazy-caching provider for the computation model.
 *
 * Builds one model per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class ComputationModelProvider extends ModelProvider {
    constructor(private readonly options: ComputationModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string) {
        return createComputationModel(apiKey, modelName, this.options);
    }
}
