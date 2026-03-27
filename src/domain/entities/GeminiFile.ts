/** Maps symbolic keys to the source-type string values stored in the DB and content blocks. */
export const GeminiFileSourceType = {
    ATTACHMENT: "attachment",
    EMBED_MEDIA: "embed_media",
} as const;

/** Discriminates the source of a Gemini file upload. */
export type GeminiFileSourceType = (typeof GeminiFileSourceType)[keyof typeof GeminiFileSourceType];

/** Maps symbolic keys to the embed media property names on a Discord embed object. */
export const EmbedMediaKey = {
    IMAGE: "image",
    VIDEO: "video",
    THUMBNAIL: "thumbnail",
} as const;

/** The property on a Discord embed that contains the uploaded media. */
export type EmbedMediaKey = (typeof EmbedMediaKey)[keyof typeof EmbedMediaKey];

/** All embed media keys in iteration order, used when scanning embed objects. */
export const EMBED_MEDIA_KEYS = Object.values(EmbedMediaKey) as readonly EmbedMediaKey[];

/**
 * Domain entity for a permanently anchored Gemini file record.
 *
 * Each row corresponds to one Discord attachment or embed media item that was
 * ever uploaded to the Gemini Files API. This entity is NEVER deleted — it holds
 * the immutable Discord context needed to re-download and re-upload the file if
 * it must be refreshed for a different API key.
 *
 * `discordMessageId` and `discordChannelId` are NOT stored here — they are sourced
 * from the joined `messages` row (via `messageId` FK) at query time to avoid duplication.
 *
 * The `originalGeminiUrl` is the URI returned at the very first upload. It is
 * stored in LangChain content blocks as the stable lookup key and never changes,
 * even as the per-key upload records are rotated out by the stale cleanup trigger.
 *
 * `sourceType` discriminates the two fetch paths:
 * - `attachment`: use `discordAttachmentId` with `IDiscordMediaService.fetchAttachment()`
 * - `embed_media`: use `embedIndex` + `embedMediaKey` with `IDiscordMediaService.fetchEmbedMedia()`
 */
export interface GeminiFile {
    /** UUID primary key */
    id: string;
    /**
     * The Gemini URI returned at first upload (e.g.
     * `"https://generativelanguage.googleapis.com/v1beta/files/<uuid>"`).
     * Immutable — stored in LangChain content blocks and used as the stable lookup key.
     */
    originalGeminiUrl: string;
    /** Discriminates the source of this file. */
    sourceType: GeminiFileSourceType;
    /** Discord attachment snowflake — stable identifier for re-downloading. Only set when sourceType = 'attachment'. */
    discordAttachmentId: string | null;
    /** Original filename as uploaded by the user in Discord. Used as displayName on re-upload. Only set when sourceType = 'attachment'. */
    discordFilename: string | null;
    /** Zero-based index of the embed in the message's embeds array. Only set when sourceType = 'embed_media'. */
    embedIndex: number | null;
    /** The property on the embed that contains the media URL. Only set when sourceType = 'embed_media'. */
    embedMediaKey: EmbedMediaKey | null;
    /** UUID primary key of the messages row that originally created this upload. FK → messages(id). */
    messageId: string;
    /** Discord message snowflake of the message that originally uploaded this file. Sourced from joined messages row. */
    discordMessageId: string;
    /** Discord channel snowflake of the channel containing the originating message. Sourced from joined messages row. */
    discordChannelId: string;
}
