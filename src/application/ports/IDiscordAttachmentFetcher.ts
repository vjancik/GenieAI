import type { DiscordAttachmentInfo } from "./IAttachmentDownloader.ts";

/**
 * Port interface for refetching a Discord attachment from the captured channel context.
 *
 * Discord CDN URLs are time-limited and cannot be reliably reconstructed from
 * attachment IDs alone. Implementations close over the Discord client and the
 * current channel ID so callers only need to provide the message and attachment
 * snowflakes.
 *
 * All messages in a Discord reply chain live in the same channel, so the channel
 * context captured at request time is valid for any historical message in the chain.
 *
 * Constructed inline in {@link DiscordGateway} per message-create event and passed
 * to {@link HandleDiscordMessageUseCase.handle} as a parameter.
 */
export interface IDiscordAttachmentFetcher {
    /**
     * Fetches a specific attachment from a message in the captured channel.
     * Returns `null` if the message or attachment no longer exists (deleted).
     *
     * @param messageDiscordId - Discord snowflake of the message to fetch
     * @param attachmentId - Discord snowflake of the specific attachment
     */
    fetchAttachment(messageDiscordId: string, attachmentId: string): Promise<DiscordAttachmentInfo | null>;
}
