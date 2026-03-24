import type { EmbedMediaKey } from "../../domain/message/GeminiFile.ts";
import type { IChatClientMessageAttachment } from "./chat/IChatClientMessageMedia.ts";

/**
 * Port interface for fetching Discord media (attachments and embed media) by
 * re-fetching the source message from the Discord API to obtain a fresh CDN URL.
 *
 * Discord CDN URLs are time-limited and cannot be reconstructed from attachment
 * IDs alone. Implementations use the injected Discord client to re-fetch messages.
 *
 * A single service instance is shared for the lifetime of the bot, with callers
 * providing the channel ID at call time rather than via constructor closure.
 */
export interface IDiscordMediaService {
    /**
     * Fetches a specific attachment from a Discord message, searching both the
     * message's own attachments and any embedded message snapshots (e.g. forwards).
     * Returns `null` if the message or attachment no longer exists (deleted).
     *
     * @param channelId - Discord snowflake of the channel containing the message
     * @param messageDiscordId - Discord snowflake of the message to fetch
     * @param attachmentId - Discord snowflake of the specific attachment
     */
    fetchAttachment(
        channelId: string,
        messageDiscordId: string,
        attachmentId: string,
    ): Promise<IChatClientMessageAttachment | null>;

    /**
     * Fetches a specific embed media item (image, video, or thumbnail) from a
     * Discord message by re-fetching the message to get a fresh CDN URL.
     * Returns `null` if the message no longer exists or the embed / media property
     * is absent at the given index.
     *
     * @param channelId - Discord snowflake of the channel containing the message
     * @param messageDiscordId - Discord snowflake of the message to fetch
     * @param embedIndex - Zero-based index of the embed in the message's embeds array
     * @param embedMediaKey - Which media property to extract: "image", "video", or "thumbnail"
     */
    fetchEmbedMedia(
        channelId: string,
        messageDiscordId: string,
        embedIndex: number,
        embedMediaKey: EmbedMediaKey,
    ): Promise<IChatClientMessageAttachment | null>;
}
