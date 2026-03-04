/**
 * Domain entity types for Discord message persistence.
 * Content is stored as an array of typed chunks to support multimodal content
 * (text, images, links) while remaining LangChain-compatible.
 */

export type TextChunk = { type: "text"; text: string };
export type ImageUrlChunk = { type: "image_url"; image_url: string };

/** A single piece of message content, typed for LangChain message format compatibility. */
export type ContentChunk = TextChunk | ImageUrlChunk;

export type MessageRole = "human" | "assistant";

/**
 * A persisted Discord message within a reply chain.
 *
 * Only the message's own content is stored (not the full conversation),
 * allowing the recursive CTE to reconstruct the chain on demand.
 */
export interface DiscordMessage {
    /** UUID primary key */
    id: string;
    /** Discord's snowflake ID for this message */
    discordMessageId: string;
    /** Discord snowflake of the message this replies to, or null if chain root */
    repliesToDiscordId: string | null;
    channelId: string;
    guildId: string | null;
    role: MessageRole;
    contentChunks: ContentChunk[];
    createdAt: Date;
}
