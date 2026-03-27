import type { BaseMessage } from "@langchain/core/messages";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";

/**
 * Port interface for resolving Discord token URL media blocks in LangChain messages
 * into Gemini Files API URIs, ready for LLM consumption in upload mode.
 *
 * For each `discord://` token block found in the history, the implementation:
 * - Finds the existing Gemini upload record for the given `apiKeyId` (if any)
 * - Uses the existing `fileUri` if the upload is still fresh
 * - Re-downloads from Discord and re-uploads to Gemini if stale or missing
 * - Drops blocks whose Discord media has been deleted
 *
 * Non-token blocks (e.g. already-resolved `fileUri` blocks from a prior mode,
 * or inline `data` blocks) are passed through unchanged.
 *
 * Gemini files are project-scoped — a file uploaded with key A is inaccessible
 * from key B — so `apiKeyId` must be provided per invocation.
 */
export interface IGeminiMediaNormalizer {
    /**
     * Resolves `discord://` token URL media blocks in `messages` into Gemini `fileUri` blocks.
     *
     * @param messages - Conversation history (may contain discord:// token URL blocks)
     * @param apiKeyId - The DB UUID of the API key currently being used for LLM invocation
     * @returns New message array with token blocks replaced by resolved Gemini fileUri blocks
     */
    normalize(messages: BaseMessage[], apiKeyId: string, onStatusUpdate?: OnStatusUpdate): Promise<BaseMessage[]>;
}
