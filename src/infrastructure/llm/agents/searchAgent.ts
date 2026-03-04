import { ChatGoogle } from "@langchain/google";
import type { AppConfig } from "../../config/config.ts";

/**
 * System prompt for the search agent.
 *
 * Explicitly instructs the model to use Google Search, because Gemini decides
 * whether to invoke grounding based on prompt content — it cannot be forced programmatically.
 */
export const SEARCH_SYSTEM_PROMPT =
    "You are a helpful assistant with access to Google Search. " +
    "You MUST use Google Search to find current, accurate, and up-to-date information before answering. " +
    "Always search for relevant information first, then synthesize a clear and accurate answer " +
    "based on the search results. " +
    "Keep your response under 1500 characters.";

/**
 * Creates the search agent model with Gemini's native Google Search grounding enabled.
 *
 * Google Search grounding is bound as a built-in tool understood by the Gemini API,
 * not as a custom LangChain tool. The model uses it autonomously when the prompt
 * instructs it to search.
 */
export function createSearchModel(config: AppConfig) {
    const llm = new ChatGoogle({
        model: "gemini-3-flash-preview",
        apiKey: config.googleApiKey,
        thinkingLevel: 'high',
    });

    // Bind the native Google Search grounding tool — this uses Gemini's built-in
    // search capability rather than a custom web search implementation.
    return llm.bindTools([{ google_search: {} }]);
}

export type SearchModel = ReturnType<typeof createSearchModel>;
