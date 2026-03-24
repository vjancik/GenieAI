/**
 * Utilities for mapping discord.js `Message` objects to application-layer types.
 *
 * Centralizes the extraction logic that was previously duplicated between
 * `DiscordGateway` and `DiscordChatMessageService`.
 *
 * Nothing in this module is intended for use outside the `discord` infrastructure folder.
 */

import type { IChatClientMessage } from "../../application/ports/chat/IChatClientMessage.ts";
import type {
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
} from "../../application/ports/chat/IChatClientMessageMedia.ts";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { DiscordEmbedInfo, DiscordMessageSnapshot } from "../../application/ports/IChatMessageService.ts";

/**
 * Maps an array of platform-agnostic attachments into the application-layer
 * {@link DiscordAttachmentInfo} type consumed by use cases.
 */
export function extractAttachments(attachments: IChatClientMessageAttachment[]): DiscordAttachmentInfo[] {
    return attachments.map((a) => ({
        id: a.id,
        url: a.url,
        proxyURL: a.proxyURL,
        name: a.name,
        size: a.size,
        contentType: a.contentType,
    }));
}

/** Formats a Date verbosely in UTC, e.g. "Monday, March 17, 2024 at 02:35:00 PM UTC". */
function formatUtcTimestamp(d: Date): string {
    // Explicit 'en-US' locale pins the output format regardless of server locale settings
    return `${d.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
    })} UTC`;
}

/**
 * Maps an array of platform-agnostic embeds into the application-layer
 * {@link DiscordEmbedInfo} type consumed by use cases.
 *
 * URL-only fields (video, image, thumbnail) are captured but intentionally
 * excluded from LLM text rendering — reserved for future media handling.
 */
export function extractEmbeds(embeds: IChatClientMessageEmbed[]): DiscordEmbedInfo[] {
    return embeds.map((embed): DiscordEmbedInfo => {
        const info: DiscordEmbedInfo = { type: embed.type };

        if (embed.title) info.title = embed.title;
        if (embed.description) info.description = embed.description;
        if (embed.author?.name) info.author = { name: embed.author.name };
        if (embed.provider?.name) info.provider = { name: embed.provider.name };

        // timestamp is an ISO 8601 string from the API; convert to a fixed verbose UTC string
        // (avoid toLocaleString() — output varies by server locale settings)
        if (embed.timestamp) info.timestamp = formatUtcTimestamp(new Date(embed.timestamp));

        if (embed.footer?.text) info.footer = { text: embed.footer.text };

        if (embed.fields.length > 0) info.fields = embed.fields.map((f) => ({ name: f.name, value: f.value }));

        const vid = embed.video;
        // proxyURL is optional (Discord omits it for some video types)
        if (vid?.url) info.video = { url: vid.url, ...(vid.proxyURL ? { proxyURL: vid.proxyURL } : {}) };

        const img = embed.image;
        if (img?.url) info.image = { url: img.url, ...(img.proxyURL ? { proxyURL: img.proxyURL } : {}) };

        const thumb = embed.thumbnail;
        if (thumb?.url) info.thumbnail = { url: thumb.url, ...(thumb.proxyURL ? { proxyURL: thumb.proxyURL } : {}) };

        return info;
    });
}

/**
 * Builds a {@link DiscordMessageSnapshot} from a platform-agnostic {@link IChatClientMessage}.
 *
 * Handles forwarded messages by reading `message.forwardedSnapshot` — when present,
 * the snapshot's content/attachments/embeds are used and `referencedMessageId` is
 * set to `null` to terminate reply-chain traversal.
 *
 * @param message - The platform-agnostic message to build from
 * @param botUserId - The current bot's user ID (for `isOwnBot` detection)
 * @param previousBotId - Optional previous bot user ID also treated as own-bot
 */
export function buildSnapshot(
    message: IChatClientMessage,
    botUserId: string | undefined,
    previousBotId: string | undefined,
): DiscordMessageSnapshot {
    const authorId = message.authorId;

    const base: Omit<DiscordMessageSnapshot, "content" | "attachments" | "referencedMessageId"> = {
        id: message.id,
        authorId,
        authorUsername: message.authorUsername,
        authorDisplayName: message.authorDisplayName,
        isBot: message.isAuthorBot,
        isOwnBot:
            (botUserId !== undefined && authorId === botUserId) ||
            (previousBotId !== undefined && authorId === previousBotId),
        channelId: message.channelId,
        // DMs have no guild — use the same sentinel used throughout the codebase
        guildId: message.guildId ?? "@me",
        createdAt: message.createdAt,
    };

    if (message.isForwarded) {
        // forwardedSnapshot is null when the snapshot map has no entry for the reference ID
        // (e.g. the source message was deleted). Still mark as forwarded and emit an empty
        // nested snapshot so consumers can handle the case gracefully.
        const fwd = message.forwardedSnapshot;
        const forwardedAttachments = fwd ? extractAttachments(fwd.attachments) : [];
        const forwardedEmbeds = fwd ? extractEmbeds(fwd.embeds) : [];
        const forwardedContent = fwd?.cleanContent ?? "";

        const nestedSnapshot: DiscordMessageSnapshot = {
            id: fwd?.id ?? "",
            content: forwardedContent,
            // Forwarded MessageSnapshot carries no author information
            authorId: "",
            authorUsername: "",
            authorDisplayName: "",
            isBot: false,
            isOwnBot: false,
            attachments: forwardedAttachments,
            ...(forwardedEmbeds.length > 0 ? { embeds: forwardedEmbeds } : {}),
            referencedMessageId: null,
            channelId: fwd?.channelId ?? message.channelId,
            guildId: message.guildId ?? "@me",
            createdAt: message.createdAt,
        };

        return {
            ...base,
            content: "",
            attachments: forwardedAttachments,
            ...(forwardedEmbeds.length > 0 ? { embeds: forwardedEmbeds } : {}),
            messageSnapshots: [nestedSnapshot],
            isForwarded: true,
            // Null terminates chain traversal — a forwarded message is a dead end
            referencedMessageId: null,
        };
    }

    const embeds = extractEmbeds(message.embeds);

    return {
        ...base,
        content: message.content,
        attachments: extractAttachments(message.attachments),
        ...(embeds.length > 0 ? { embeds } : {}),
        referencedMessageId: message.referencedMessageId,
    };
}
