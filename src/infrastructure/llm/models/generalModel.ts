import * as Sentry from "@sentry/bun";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import { buildRetrievedContextHints, type RetrievedContextHints, SYSTEM_PROMPT_FOOTER } from "./basePrompt.ts";
import { blockNoneSafetySettings, neverTool, noInternalRetries } from "./sharedGeminiSettings.ts";
import { ValidatedChatGoogle } from "./ValidatedChatGoogle.ts";

/**
 * Builds the system prompt for the general-purpose agent.
 * Injects the current date so the model knows its base knowledge is outdated.
 *
 * @param hints - What the tools of the turn retrieved, see {@link buildRetrievedContextHints}
 */
export function buildGeneralSystemPrompt(basePrompt: string, hints: RetrievedContextHints = {}): string {
    const dateStr = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    return (
        basePrompt +
        "\n" +
        `You should assume the current date is ${dateStr} and your base knowledge is outdated by more than a year. Do not mention the date unless the user asks about it.\n` +
        buildRetrievedContextHints(hints) +
        "You are not allowed to call any tools.\n" +
        "In the absence of a specific query or request regarding a provided link, assume the user is requesting a summary of the content." +
        SYSTEM_PROMPT_FOOTER
    );
}
/** Dependencies for constructing a general model provider instance. */
interface GeneralModelOptions {
    /** Gemini model identifier (e.g. "gemini-2.0-flash"). */
    modelName: string;
    /** Fallback model name used on 503 or timeout errors. */
    fallbackModelName?: string;
    /** Whether to include thought tokens in the model response. */
    includeThoughts: boolean;
}

/**
 * Creates the general-purpose model — the stronger Gemini model used for
 * everything that needs neither code execution nor Google Search grounding, including
 * evaluating web page, video and web search tool results.
 */
function createGeneralModel(
    apiKey: string,
    modelName: string,
    options: Omit<GeneralModelOptions, "modelName" | "fallbackModelName">,
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

    // `tool_choice` is omitted deliberately: ValidatedChatGoogle replaces the derived
    // toolConfig wholesale with VALIDATED mode. `neverTool` stays bound so a declared
    // function is always present, and its description reinforces the system prompt's
    // instruction not to call tools.
    return llm.bindTools([neverTool]);
}

/**
 * Lazy-caching provider for the general-purpose model.
 *
 * Builds one {@link GeneralModel} per unique `[apiKey, modelName]` pair.
 * The fallback model (if configured) is cached in the same map under its own key.
 */
export class GeneralModelProvider extends ModelProvider {
    constructor(private readonly options: GeneralModelOptions) {
        super(options.modelName, options.fallbackModelName);
    }

    protected create(apiKey: string, modelName: string) {
        return createGeneralModel(apiKey, modelName, this.options);
    }
}
