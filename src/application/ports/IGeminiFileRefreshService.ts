import type { BaseMessage } from "@langchain/core/messages";

/**
 * Port for pre-invocation Gemini file refresh.
 *
 * Ensures all Gemini file URL references in the conversation history are fresh
 * and valid for the given API key before a model is invoked.
 */
export interface IGeminiFileRefreshService {
    /**
     * Returns a new message array with stale Gemini file URLs substituted for
     * fresh ones, uploading or re-uploading files as needed.
     *
     * @param messages  - Current conversation history
     * @param apiKeyId  - The DB UUID of the API key being used for this invocation
     * @returns New message array (messages without Gemini URLs pass through unchanged)
     */
    refreshHistory(messages: BaseMessage[], apiKeyId: string): Promise<BaseMessage[]>;
}
