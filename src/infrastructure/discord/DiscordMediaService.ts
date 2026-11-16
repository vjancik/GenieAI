import type { Client, Embed, Message } from "discord.js";
import type { IChatClientMessageAttachment } from "../../application/ports/chat/IChatClient.ts";
import type { IDiscordMediaService } from "../../application/ports/IDiscordMediaService.ts";
import type { EmbedMediaKey } from "../../domain/entities/GeminiFile.ts";
import type { DiscordClient } from "./DiscordClient.ts";
import type { EmbedComponentMedia } from "./embedComponents.ts";
import { parseEmbedComponents } from "./embedComponents.ts";

/** Finds a media item by ID in the component tree of the given embed, if it has one. */
function findComponentMedia(embed: Embed | undefined, mediaId: string): EmbedComponentMedia | null {
    if (!embed) return null;
    return parseEmbedComponents(embed.data).media.find((media) => media.id === mediaId) ?? null;
}

/**
 * Fetches Discord media (attachments and embed media) by re-fetching the source
 * message from the Discord API to obtain a fresh CDN URL.
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
    ): Promise<IChatClientMessageAttachment | null> {
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

    async fetchEmbedMedia(
        channelId: string,
        messageDiscordId: string,
        embedIndex: number,
        embedMediaKey: EmbedMediaKey,
    ): Promise<IChatClientMessageAttachment | null> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel?.isTextBased()) return null;

            const msg = await channel.messages.fetch(messageDiscordId);
            const embed = msg.embeds[embedIndex];
            let media = embed?.[embedMediaKey];

            // Fall back to searching embeds across all messageSnapshots (e.g. forwards)
            if (!media?.url) {
                for (const snapshot of msg.messageSnapshots.values()) {
                    const snapshotMedia = snapshot.embeds[embedIndex]?.[embedMediaKey];
                    if (snapshotMedia?.url) {
                        media = snapshotMedia;
                        break;
                    }
                }
            }

            if (!media?.url) return null;

            // Synthesize a display name in the form "Embed-<index>-<Key>" (e.g. "Embed-0-Image")
            const capitalizedKey = (embedMediaKey.charAt(0).toUpperCase() +
                embedMediaKey.slice(1)) as Capitalize<EmbedMediaKey>;
            const name = `Embed-${embedIndex + 1}-${capitalizedKey}`;

            // Prefer proxyURL as the primary fetch target — for link-preview embeds the original
            // URL is often a webpage, while Discord's CDN proxy reliably serves the actual media bytes.
            // Falls back to the original URL if proxyURL is unavailable.
            const proxyURL = media.proxyURL ?? media.url;
            return {
                // Use the original URL as a stable pseudo-ID — embed media items have no Discord snowflake
                id: media.url,
                url: proxyURL,
                proxyURL: media.url,
                name,
                // Embed media items do not carry a file size; use 0 as a sentinel
                size: 0,
                // Content type is not available from embed metadata; resolved from HTTP response on download
                contentType: null,
            };
        } catch {
            return null;
        }
    }

    async fetchEmbedComponentMedia(
        channelId: string,
        messageDiscordId: string,
        embedIndex: number,
        mediaId: string,
    ): Promise<IChatClientMessageAttachment | null> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel?.isTextBased()) return null;

            const msg: Message = await channel.messages.fetch(messageDiscordId);

            // The embed the token was built from is tried first. The ID alone identifies the item,
            // so the remaining embeds — the message's own, then those of any messageSnapshots
            // (e.g. forwards) — are searched as well in case the index no longer lines up.
            const embeds = [
                msg.embeds[embedIndex],
                ...msg.embeds,
                ...[...msg.messageSnapshots.values()].flatMap((snapshot) => snapshot.embeds),
            ];
            let media: EmbedComponentMedia | null = null;
            for (const embed of embeds) {
                media = findComponentMedia(embed, mediaId);
                if (media) break;
            }

            if (!media) return null;

            return {
                id: media.id,
                // Same preference as classic embed media: Discord's proxy reliably serves the bytes,
                // the original URL is the fallback.
                url: media.proxyURL ?? media.url,
                proxyURL: media.url,
                name: `Embed-${embedIndex + 1}-Media-${media.id}`,
                // Embed media items do not carry a file size; use 0 as a sentinel
                size: 0,
                // Left null on purpose, like classic embed media: the downloaders then validate the
                // HTTP response type against the expected one, instead of trusting it blindly —
                // a host that answers with an HTML page must not be passed on as media.
                contentType: null,
            };
        } catch {
            return null;
        }
    }
}
