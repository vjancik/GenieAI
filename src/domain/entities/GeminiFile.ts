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
 * That context is `originalGeminiUrl`, a `discord://` token URL. It identifies the
 * guild, channel, message and the specific media item (attachment, embed media slot
 * or embed component media), and is parsed whenever the file has to be re-fetched.
 *
 * `discordMessageId` and `discordChannelId` are NOT stored here — they are sourced
 * from the joined `messages` row (via `messageId` FK) at query time to avoid duplication.
 */
export interface GeminiFile {
    /** UUID primary key */
    id: string;
    /**
     * The `discord://` token URL of the media item. Immutable — stored in LangChain
     * content blocks and used as the stable lookup key, even as the per-key upload
     * records are rotated out by the stale cleanup trigger.
     * The name predates token URLs, when it held the first Gemini upload URI.
     */
    originalGeminiUrl: string;
    /** UUID primary key of the messages row that originally created this upload. FK → messages(id). */
    messageId: string;
    /** Discord message snowflake of the message that originally uploaded this file. Sourced from joined messages row. */
    discordMessageId: string;
    /** Discord channel snowflake of the channel containing the originating message. Sourced from joined messages row. */
    discordChannelId: string;
}
