/**
 * Maps a MIME type string to the LangChain content block type understood by ChatGoogle.
 *
 * Recognized block types (from {@link https://github.com/langchain-ai/langchainjs/blob/a596d3f7395c0ab27357aa0cd30bafb2d5d967c1/libs/langchain-core/src/messages/content/multimodal.ts#L5 GitHub} KNOWN_BLOCK_TYPES):
 *   "image" | "video" | "audio" | "text-plain" | "file"
 *
 * "file" is the catch-all for any MIME type that doesn't map to a more specific type.
 * We let the model reject unsupported file types rather than pre-filtering here.
 */
export type LangChainBlockType =
    | "image"
    | "video"
    | "audio"
    | "text-plain"
    | "file";

/**
 * Returns the LangChain content block type for a given MIME type.
 *
 * @param mimeType - The MIME type string (e.g. "image/jpeg", "audio/wav")
 * @returns The corresponding LangChain block type
 */
export function getBlockType(mimeType: string): LangChainBlockType {
    const lower = mimeType.toLowerCase();
    if (lower.startsWith("image/")) return "image";
    if (lower.startsWith("video/")) return "video";
    if (lower.startsWith("audio/")) return "audio";
    if (lower === "text/plain") return "text-plain";
    return "file";
}
