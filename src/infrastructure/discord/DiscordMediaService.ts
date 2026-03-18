import type { Client } from "discord.js";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { IDiscordMediaService } from "../../application/ports/IDiscordMediaService.ts";
import type { DiscordClient } from "./DiscordClient.ts";

/**
 * Fetches Discord media (attachments) by re-fetching the source message from the
 * Discord API to obtain a fresh CDN URL.
 *
 * Searches the message's own attachments first, then falls back to any embedded
 * `messageSnapshots` (e.g. forwarded messages) if the attachment is not found
 * directly on the message. This covers cases where the attachment's source is
 * ambiguous — for example when the attachment originates from a forwarded message
 * and the stored `discordMessageId` may point to the outer forwarding message.
 */
export class DiscordMediaService implements IDiscordMediaService {
    private readonly client: Client;

    constructor(discordClient: DiscordClient) {
        this.client = discordClient.client;
    }

    async fetchAttachment(
        channelId: string,
        messageDiscordId: string,
        attachmentId: string,
    ): Promise<DiscordAttachmentInfo | null> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel?.isTextBased()) return null;

            const msg = await channel.messages.fetch(messageDiscordId);

            // Search the message's own attachments first
            const directAttachment = msg.attachments.get(attachmentId);
            if (directAttachment) {
                return {
                    id: directAttachment.id,
                    url: directAttachment.url,
                    proxyURL: directAttachment.proxyURL,
                    name: directAttachment.name ?? "attachment",
                    size: directAttachment.size,
                    contentType: directAttachment.contentType,
                };
            }

            // Fall back to searching attachments across all messageSnapshots (e.g. forwards)
            for (const snapshot of msg.messageSnapshots.values()) {
                const snapshotAttachment = snapshot.attachments.get(attachmentId);
                if (snapshotAttachment) {
                    return {
                        id: snapshotAttachment.id,
                        url: snapshotAttachment.url,
                        proxyURL: snapshotAttachment.proxyURL,
                        name: snapshotAttachment.name ?? "attachment",
                        size: snapshotAttachment.size,
                        contentType: snapshotAttachment.contentType,
                    };
                }
            }

            return null;
        } catch {
            return null;
        }
    }
}
