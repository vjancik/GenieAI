/**
 * Thin platform-agnostic interfaces for message attachments and embeds.
 *
 * Concrete implementations (e.g. DiscordClientMessageAttachment) are lazy wrappers
 * over platform objects — properties are JIT getters that delegate to the underlying
 * platform object rather than copying data on construction.
 *
 * The extractor functions in messageExtractors.ts accept these interfaces instead of
 * raw discord.js types, keeping discord.js out of the application layer.
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
    readonly proxyURL: string | null | undefined;
}

/**
 * Thin wrapper over a forwarded message snapshot attached to a chat message.
 * Discord's MessageSnapshot carries no author information — only content and media.
 */
export interface IChatClientMessageSnapshot {
    /** Snowflake ID of the forwarded source message. */
    readonly id: string;
    /** Text content of the forwarded message. */
    readonly content: string;
    /**
     * Message content with mention snowflakes resolved to human-readable display names.
     * May equal `content` when no mentions are present.
     */
    readonly cleanContent: string;
    /** File attachments on the forwarded message. Empty array when there are none. */
    readonly attachments: IChatClientMessageAttachment[];
    /** Embeds on the forwarded message. Empty array when there are none. */
    readonly embeds: IChatClientMessageEmbed[];
    /** The channel the original message was forwarded from. */
    readonly channelId: string;
}

/** Thin wrapper over an embed attached to a chat message. */
export interface IChatClientMessageEmbed {
    /** Embed type — e.g. "rich", "image", "video". */
    readonly type: string;
    readonly title: string | null | undefined;
    readonly description: string | null | undefined;
    readonly author: { readonly name: string } | null | undefined;
    readonly provider: { readonly name: string } | null | undefined;
    /** Raw ISO 8601 timestamp string, or null/undefined when absent. */
    readonly timestamp: string | null | undefined;
    readonly footer: { readonly text: string } | null | undefined;
    readonly fields: IChatClientMessageEmbedField[];
    readonly video: IChatClientMessageEmbedMedia | null | undefined;
    readonly image: IChatClientMessageEmbedMedia | null | undefined;
    readonly thumbnail: IChatClientMessageEmbedMedia | null | undefined;
}
