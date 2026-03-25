/**
 * Utilities for encoding and decoding Discord media token URLs.
 *
 * Inline-mode attachment blocks in LangChain messages store a lightweight token
 * URL instead of raw base64 payload. This allows messages to be persisted in
 * Postgres without embedding potentially large binary blobs, while retaining
 * enough context to re-fetch the media from Discord on demand.
 *
 * Token URL formats:
 *   Attachment:  discord://guildId/channelId/messageId/attachmentId
 *   Embed media: discord://guildId/channelId/messageId/embed/embedIndex/mediaKey
 */

import type { EmbedMediaKey } from "../../domain/message/GeminiFile.ts";

/** Protocol prefix used for all Discord token URLs. */
const DISCORD_PROTOCOL = "discord:";

/** Discriminated union representing a parsed Discord token URL. */
export type DiscordTokenUrl =
    | {
          kind: "attachment";
          guildId: string;
          channelId: string;
          messageId: string;
          attachmentId: string;
      }
    | {
          kind: "embed";
          guildId: string;
          channelId: string;
          messageId: string;
          embedIndex: number;
          mediaKey: EmbedMediaKey;
      };

/**
 * Builds a `discord://` token URL for a Discord attachment.
 *
 * @param guildId - Discord guild snowflake (or "@me" for DMs)
 * @param channelId - Discord channel snowflake
 * @param messageId - Discord message snowflake
 * @param attachmentId - Discord attachment snowflake
 */
export function buildAttachmentTokenUrl(
    guildId: string,
    channelId: string,
    messageId: string,
    attachmentId: string,
): string {
    return `discord://${guildId}/${channelId}/${messageId}/${attachmentId}`;
}

/**
 * Builds a `discord://` token URL for an embed media item.
 *
 * @param guildId - Discord guild snowflake (or "@me" for DMs)
 * @param channelId - Discord channel snowflake
 * @param messageId - Discord message snowflake
 * @param embedIndex - Zero-based index of the embed in the message's embeds array
 * @param mediaKey - Which media property: "image", "video", or "thumbnail"
 */
export function buildEmbedTokenUrl(
    guildId: string,
    channelId: string,
    messageId: string,
    embedIndex: number,
    mediaKey: EmbedMediaKey,
): string {
    return `discord://${guildId}/${channelId}/${messageId}/embed/${embedIndex}/${mediaKey}`;
}

/**
 * Returns true if the given string is a Discord token URL.
 * Only checks the protocol prefix — use {@link parseDiscordTokenUrl} for full validation.
 */
export function isDiscordTokenUrl(value: string): boolean {
    return value.startsWith(`${DISCORD_PROTOCOL}//`);
}

/**
 * Parses a Discord token URL into a typed {@link DiscordTokenUrl} object.
 * Returns `null` if the URL is not a valid Discord token URL or cannot be parsed.
 */
export function parseDiscordTokenUrl(url: string): DiscordTokenUrl | null {
    if (!isDiscordTokenUrl(url)) return null;

    // URL API requires a valid base URL; discord:// is not a registered scheme,
    // so we substitute https:// for parsing then extract path segments manually.
    let parsed: URL;
    try {
        parsed = new URL(url.replace(DISCORD_PROTOCOL, "https:"));
    } catch {
        return null;
    }

    // hostname is guildId; pathname starts with a leading "/"
    const guildId = parsed.hostname;
    const segments = parsed.pathname.replace(/^\//, "").split("/");

    // Minimum: channelId / messageId / attachmentId (3 segments)
    if (segments.length < 3) return null;

    const [channelId, messageId, ...rest] = segments as [string, string, ...string[]];
    if (!channelId || !messageId) return null;

    if (rest[0] === "embed") {
        // Embed: embed / embedIndex / mediaKey (3 more segments after channelId/messageId)
        if (rest.length < 3) return null;
        const embedIndex = Number(rest[1]);
        if (!Number.isInteger(embedIndex) || embedIndex < 0) return null;
        const mediaKey = rest[2] as EmbedMediaKey;
        if (mediaKey !== "image" && mediaKey !== "video" && mediaKey !== "thumbnail") return null;
        return { kind: "embed", guildId, channelId, messageId, embedIndex, mediaKey };
    }

    // Attachment: attachmentId is rest[0]
    const attachmentId = rest[0];
    if (!attachmentId) return null;
    return { kind: "attachment", guildId, channelId, messageId, attachmentId };
}
