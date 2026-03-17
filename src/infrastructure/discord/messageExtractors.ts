/**
 * Utilities for mapping discord.js `Message` objects to application-layer types.
 *
 * Centralizes the extraction logic that was previously duplicated between
 * `DiscordGateway` and `DiscordChatMessageService`.
 *
 * Nothing in this module is intended for use outside the `discord` infrastructure folder.
 */

import { type Embed, type Message, MessageReferenceType, type MessageSnapshot } from "discord.js";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { DiscordEmbedInfo, DiscordMessageSnapshot } from "../../application/ports/IChatMessageService.ts";

/** Shape covering both `Message` and `MessageSnapshot` for attachment extraction. */
type AttachmentSource = Pick<Message, "attachments">;

/** Shape covering both `Message` and `MessageSnapshot` for embed extraction. */
type EmbedSource = Pick<Message, "embeds">;

/**
 * Extracts file attachments from a Discord message or message snapshot into the
 * application-layer {@link DiscordAttachmentInfo} type.
 */
export function extractAttachments(source: AttachmentSource): DiscordAttachmentInfo[] {
    return [...source.attachments.values()].map((a) => ({
        id: a.id,
        url: a.url,
        proxyURL: a.proxyURL,
        name: a.name ?? "attachment",
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
 * Extracts embed metadata from a Discord message or message snapshot into the
 * application-layer {@link DiscordEmbedInfo} type.
 *
 * URL-only fields (video, image, thumbnail) are captured but intentionally
 * excluded from LLM text rendering — reserved for future media handling.
 */
export function extractEmbeds(source: EmbedSource): DiscordEmbedInfo[] {
    return source.embeds.map((embed: Embed): DiscordEmbedInfo => {
        const info: DiscordEmbedInfo = {
            // `Embed` has no `.type` getter — access the raw API data field
            type: embed.data.type ?? "rich",
        };

        if (embed.title) info.title = embed.title;
        if (embed.description) info.description = embed.description;
        if (embed.author?.name) info.author = { name: embed.author.name };
        if (embed.provider?.name) info.provider = { name: embed.provider.name };

        // timestamp is an ISO 8601 string from the API; convert to a fixed verbose UTC string
        // (avoid toLocaleString() — output varies by server locale settings)
        if (embed.timestamp) info.timestamp = formatUtcTimestamp(new Date(embed.timestamp));

        if (embed.footer?.text) info.footer = { text: embed.footer.text };

        const fields = embed.fields.filter((f) => f.name || f.value);
        if (fields.length > 0) info.fields = fields.map((f) => ({ name: f.name, value: f.value }));

        const vid = embed.video;
        // APIEmbedVideo.url is optional (Discord omits it for some video types)
        if (vid?.url) info.video = { url: vid.url, ...(vid.proxyURL ? { proxyURL: vid.proxyURL } : {}) };

        const img = embed.image;
        if (img?.url) info.image = { url: img.url, ...(img.proxyURL ? { proxyURL: img.proxyURL } : {}) };

        const thumb = embed.thumbnail;
        if (thumb?.url) info.thumbnail = { url: thumb.url, ...(thumb.proxyURL ? { proxyURL: thumb.proxyURL } : {}) };

        return info;
    });
}

/**
 * Builds a {@link DiscordMessageSnapshot} from a discord.js `Message`.
 *
 * Handles forwarded messages (Discord `MessageReferenceType.Forward`) by
 * populating `messageSnapshots`, `isForwarded`, and setting content from the
 * forwarded `MessageSnapshot` rather than `message.content` (which is empty on
 * forwarded messages). Also sets `referencedMessageId` to `null` for forwards,
 * naturally terminating any reply-chain traversal at a forwarded message.
 *
 * @param message - The discord.js Message to extract from
 * @param botUserId - The current bot's Discord user ID (for `isOwnBot` detection)
 * @param previousBotId - Optional previous bot user ID also treated as own-bot
 */
export function buildSnapshot(
    message: Message,
    botUserId: string | undefined,
    previousBotId: string | undefined,
): DiscordMessageSnapshot {
    const authorId = message.author.id;

    const base: Omit<DiscordMessageSnapshot, "content" | "attachments" | "referencedMessageId"> = {
        id: message.id,
        authorId,
        authorUsername: message.author.username,
        // Guild-aware display name: nickname > globalName > username (discord.js computed)
        authorDisplayName: message.member?.displayName ?? message.author.displayName,
        isBot: message.author.bot,
        isOwnBot:
            (botUserId !== undefined && authorId === botUserId) ||
            (previousBotId !== undefined && authorId === previousBotId),
        channelId: message.channelId,
        // DMs have no guild — use the same sentinel used throughout the codebase
        guildId: message.guildId ?? "@me",
        createdAt: message.createdAt,
    };

    const isForwarded = message.reference?.type === MessageReferenceType.Forward;

    if (isForwarded) {
        const refMessageId = message.reference?.messageId;
        const msgSnapshot: MessageSnapshot | undefined =
            refMessageId !== undefined ? message.messageSnapshots.get(refMessageId) : undefined;

        // cleanContent resolves mention snowflakes to human-readable names;
        // fall back to raw content if cleanContent is null on the snapshot type
        const forwardedContent = msgSnapshot ? (msgSnapshot.cleanContent ?? msgSnapshot.content) : "";

        const forwardedAttachments = msgSnapshot ? extractAttachments(msgSnapshot) : [];
        const forwardedEmbeds = msgSnapshot ? extractEmbeds(msgSnapshot) : [];

        const nestedSnapshot: DiscordMessageSnapshot = {
            id: refMessageId ?? "",
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
            channelId: message.reference?.channelId ?? message.channelId,
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

    const embeds = extractEmbeds(message);

    return {
        ...base,
        content: message.content,
        attachments: extractAttachments(message),
        ...(embeds.length > 0 ? { embeds } : {}),
        referencedMessageId: message.reference?.messageId ?? null,
    };
}
