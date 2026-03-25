/**
 * Thin platform-agnostic interfaces for message attachments, embeds, and snapshots.
 *
 * Concrete implementations (e.g. DiscordClientMessageAttachment) are lazy wrappers
 * over platform objects — properties are JIT getters that delegate to the underlying
 * platform object rather than copying data on construction.
 *
 * These interfaces serve as the unified application-layer message types, replacing
 * the former `DiscordAttachmentInfo`, `DiscordEmbedInfo`, and `DiscordMessageSnapshot`
 * types that were defined separately in the port files.
 */

/** Thin wrapper over a file attachment on a chat message. */
export interface IChatClientMessageAttachment {
    readonly id: string;
    readonly url: string;
    readonly proxyURL: string;
    /** Original filename; implementations should default to "attachment" when absent. */
    readonly name: string;
    readonly size: number;
    readonly contentType: string | null;
}

/** Thin wrapper over a single embed field (name/value pair). */
export interface IChatClientMessageEmbedField {
    readonly name: string;
    readonly value: string;
}

/** Thin wrapper over a media object on an embed (image, video, thumbnail). */
export interface IChatClientMessageEmbedMedia {
    readonly url: string;
    readonly proxyURL: string | null;
}

/** Content of the source message in a Discord forward. */
export interface IChatClientMessageSnapshot {
    /** Raw message content. Null when unavailable. */
    readonly content: string | null;
    /** Message content with mention snowflakes resolved to human-readable display names. Null when unavailable. */
    readonly cleanContent: string | null;
    /** File attachments on the message. Empty array when there are none. */
    readonly attachments: IChatClientMessageAttachment[];
    /** Embeds on the message. Empty array when there are none. */
    readonly embeds: IChatClientMessageEmbed[];
}

/** Thin wrapper over an embed attached to a chat message. */
export interface IChatClientMessageEmbed {
    /** Embed type — e.g. "rich", "image", "video". Undefined when the platform does not provide one. */
    readonly type: string | null;
    readonly title: string | null;
    readonly description: string | null;
    /** Author name, or null/undefined when absent. */
    readonly authorName: string | null;
    /** Provider name (e.g. "YouTube"), or null/undefined when absent. */
    readonly providerName: string | null;
    /** Raw ISO 8601 timestamp string, or null/undefined when absent. */
    readonly timestamp: string | null;
    /** Footer text, or null/undefined when absent. */
    readonly footerText: string | null;
    readonly fields: IChatClientMessageEmbedField[];
    readonly video: IChatClientMessageEmbedMedia | null;
    readonly image: IChatClientMessageEmbedMedia | null;
    readonly thumbnail: IChatClientMessageEmbedMedia | null;
}
