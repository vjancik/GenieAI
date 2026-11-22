import type { BaseMessage } from "@langchain/core/messages";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";

/**
 * Port interface for resolving media token URL blocks in LangChain messages
 * into Gemini Files API URIs, ready for LLM consumption in upload mode.
 *
 * For each token block found in the history (a `discord://` token, or the `http(s)://` URL of
 * a file fetched from the web), the implementation:
 * - Finds the existing Gemini upload record for the given `apiKeyId` (if any)
 * - Uses the existing `fileUri` if the upload is still fresh
 * - Re-downloads from the media's origin and re-uploads to Gemini if stale or missing
 * - Drops blocks whose media is gone from its origin
 *
 * Non-token blocks (e.g. already-resolved `fileUri` blocks from a prior mode,
 * or inline `data` blocks) are passed through unchanged.
 *
 * Gemini files are project-scoped — a file uploaded with key A is inaccessible
 * from key B — so `apiKeyId` must be provided per invocation.
 */
export interface IGeminiMediaNormalizer {
    /**
     * Resolves media token URL blocks in `messages` into Gemini `fileUri` blocks.
     *
     * @param messages - Conversation history (may contain media token URL blocks)
     * @param apiKeyId - The DB UUID of the API key currently being used for LLM invocation
     * @returns New message array with token blocks replaced by resolved Gemini fileUri blocks
     */
    normalize(messages: BaseMessage[], apiKeyId: string, onStatusUpdate?: OnStatusUpdate): Promise<BaseMessage[]>;
}
