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
 *   Embed component media:
 *                discord://guildId/channelId/messageId/embed/embedIndex/componentMedia/mediaId
 *
 * The two embed forms address different things. A classic embed has at most one
 * media item per named slot, so the slot name (`mediaKey`) is enough. A "components"
 * embed has no slots — its media sits in a component tree and a gallery can hold
 * several items — so each item is addressed by its own snowflake ID instead.
 */

import type { EmbedMediaKey } from "../../domain/entities/GeminiFile.ts";

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
      }
    | {
          kind: "embedComponentMedia";
          guildId: string;
          channelId: string;
          messageId: string;
          /** Index of the embed the media was found on. A hint only — `mediaId` is what identifies the item. */
          embedIndex: number;
          mediaId: string;
      };

/** Path segment that marks the embed component media form; cannot collide with an {@link EmbedMediaKey}. */
const COMPONENT_MEDIA_SEGMENT = "componentMedia";

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
 * Builds a `discord://` token URL for a media item nested in the component tree of a
 * "components" embed.
 *
 * @param guildId - Discord guild snowflake (or "@me" for DMs)
 * @param channelId - Discord channel snowflake
 * @param messageId - Discord message snowflake
 * @param embedIndex - Zero-based index of the embed in the message's embeds array
 * @param mediaId - Snowflake of the media item, stable across re-fetches of the message
 */
export function buildEmbedComponentMediaTokenUrl(
    guildId: string,
    channelId: string,
    messageId: string,
    embedIndex: number,
    mediaId: string,
): string {
    return `discord://${guildId}/${channelId}/${messageId}/embed/${embedIndex}/${COMPONENT_MEDIA_SEGMENT}/${mediaId}`;
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
 *
 * Uses manual string splitting rather than the `URL` constructor because Discord
 * snowflakes are purely numeric strings and the URL API interprets numeric-only
 * hostnames as IPv4 addresses (e.g. "123456789" → "7.91.205.21").
 */
export function parseDiscordTokenUrl(url: string): DiscordTokenUrl | null {
    if (!isDiscordTokenUrl(url)) return null;

    // Strip the "discord://" prefix and split the remaining path by "/"
    const withoutProtocol = url.slice(`${DISCORD_PROTOCOL}//`.length);
    const segments = withoutProtocol.split("/");

    // Minimum segments: guildId / channelId / messageId / attachmentId (4)
    if (segments.length < 4) return null;

    const [guildId, channelId, messageId, ...rest] = segments;
    if (!guildId || !channelId || !messageId) return null;

    if (rest[0] === "embed") {
        // Embed formats: embed / embedIndex / mediaKey (3 elements after messageId),
        // or embed / embedIndex / componentMedia / mediaId (4 elements)
        if (rest.length < 3) return null;
        const embedIndex = Number(rest[1]);
        if (!Number.isInteger(embedIndex) || embedIndex < 0) return null;
        if (rest[2] === COMPONENT_MEDIA_SEGMENT) {
            const mediaId = rest[3];
            if (!mediaId) return null;
            return { kind: "embedComponentMedia", guildId, channelId, messageId, embedIndex, mediaId };
        }
        const mediaKey = rest[2];
        if (mediaKey !== "image" && mediaKey !== "video" && mediaKey !== "thumbnail") return null;
        return { kind: "embed", guildId, channelId, messageId, embedIndex, mediaKey };
    }

    // Attachment format: attachmentId is rest[0]
    const attachmentId = rest[0];
    if (!attachmentId) return null;
    return { kind: "attachment", guildId, channelId, messageId, attachmentId };
}
