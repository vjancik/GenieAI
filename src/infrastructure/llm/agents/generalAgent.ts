import { ChatGoogle } from "@langchain/google";

/**
 * System prompt for the general-purpose agent.
 * Keeps responses within Discord's practical character limit.
 */
export const GENERAL_SYSTEM_PROMPT =
    "You are Genie, a helpful AI assistant on Discord. " +
    "Answer questions clearly, accurately, and concisely. " +
    "Keep your response under 1500 characters.";

/**
 * Creates the general-purpose model — the stronger Gemini model used for
 * all non-search routes, including evaluating web page and video tool results.
 *
 * @param params.apiKey - Google API key for this model instance
 * @param params.modelName - Gemini model identifier (e.g. "gemini-2.0-flash")
 * @param params.includeLLMThoughts - Whether to include thought tokens in responses
 */
export function createGeneralModel(params: {
    apiKey: string;
    modelName: string;
    includeLLMThoughts: boolean;
}) {
    return new ChatGoogle({
        model: params.modelName,
        apiKey: params.apiKey,
        thinkingConfig: {
            thinkingLevel: "high",
            includeThoughts: params.includeLLMThoughts,
        },
    });
}

export type GeneralModel = ReturnType<typeof createGeneralModel>;
