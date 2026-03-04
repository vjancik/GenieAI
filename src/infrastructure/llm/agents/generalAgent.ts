import { ChatGoogle } from "@langchain/google";
import type { AppConfig } from "../../config/config.ts";

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
 */
export function createGeneralModel(config: AppConfig) {
    return new ChatGoogle({
        model: "gemini-3-flash-preview",
        apiKey: config.googleApiKey,
        thinkingLevel: 'high',
    });
}

export type GeneralModel = ReturnType<typeof createGeneralModel>;
