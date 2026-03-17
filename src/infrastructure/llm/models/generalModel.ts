import { ChatGoogle } from "@langchain/google/node";
import * as Sentry from "@sentry/bun";
import type { ThinkingLevel } from "../../../application/types/ThinkingLevel.ts";
import { ModelProvider } from "../ModelProvider.ts";
import { BASE_USER_FACING_PROMPT, SYSTEM_PROMPT_FOOTER } from "./basePrompt.ts";

// TODO: rebuild only once a day, return cached otherwise
/**
 * Builds the system prompt for the general-purpose agent.
 * Injects the current date so the model knows its base knowledge is outdated.
 *
 * @param dateStr - ISO date string representing today's date (e.g. "2026-03-14")
 * @param includeVideoCaptionHints - Whether to include video caption timestamp instructions.
 *   Only injected when a get_video_captions ToolMessage is present in history, to avoid
 *   triggering hallucinated tool calls on models that confuse timestamp hints with tool use.
 */
export function buildGeneralSystemPrompt(
    dateStr: string,
    includeVideoCaptionHints = false,
    hasToolResult = false,
): string {
    return (
        BASE_USER_FACING_PROMPT +
        "\n" +
        `You should assume the current date is ${dateStr} and your base knowledge is outdated by more than a year. Do not mention the date unless the user asks about it.\n` +
        (includeVideoCaptionHints
            ? "If video captions are available, you should use timestamps to refer to specific parts of the video. The timestamps should be in the format (MM:SS) without leading zeroes.\n"
            : "") +
        (hasToolResult
            ? "If previous tool calls all failed, you should inform the user of the failure instead of trying to satisfy the user's request without the necessary information.\n"
            : "") +
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

    const llm = new ChatGoogle({
        model: modelName,
        apiKey,
        thinkingConfig: {
            thinkingLevel: "HIGH" satisfies ThinkingLevel,
            includeThoughts: options.includeLLMThoughts,
        },
        callbacks: sentryCallback,
    });

    return llm.bindTools([], { tool_choice: "none" });
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
