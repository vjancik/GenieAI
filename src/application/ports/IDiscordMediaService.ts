import type { DiscordAttachmentInfo } from "./IAttachmentDownloader.ts";

/**
 * Port interface for fetching Discord media (attachments) by re-fetching the
 * source message from the Discord API to obtain a fresh CDN URL.
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
    ): Promise<DiscordAttachmentInfo | null>;
}
