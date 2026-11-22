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
 * Each row corresponds to one media item that was ever uploaded to the Gemini Files API:
 * a Discord attachment or embed media item, or a file fetched from the web. This entity is
 * NEVER deleted — it holds the immutable context needed to re-download and re-upload the
 * file if it must be refreshed for a different API key.
 *
 * That context is `originalGeminiUrl`, a media token URL. For Discord media it is a
 * `discord://` token identifying the guild, channel, message and the specific media item
 * (attachment, embed media slot or embed component media). For a file from the web it is
 * the file's own `http(s)://` URL.
 *
 * A Discord anchor belongs to the message the media was posted in. An external file belongs
 * to no message: one anchor per URL is shared by every conversation that fetches it, so its
 * message fields are null.
 *
 * `discordMessageId` and `discordChannelId` are NOT stored here — they are sourced
 * from the joined `messages` row (via `messageId` FK) at query time to avoid duplication.
 */
export interface GeminiFile {
    /** UUID primary key */
    id: string;
    /**
     * The media token URL of the item (`discord://…` or `http(s)://…`). Immutable — stored in LangChain
     * content blocks and used as the stable lookup key, even as the per-key upload
     * records are rotated out by the stale cleanup trigger.
     * The name predates token URLs, when it held the first Gemini upload URI.
     */
    originalGeminiUrl: string;
    /**
     * UUID primary key of the messages row that originally created this upload. FK → messages(id).
     * Null for an external file.
     */
    messageId: string | null;
    /**
     * Discord message snowflake of the message that originally uploaded this file. Sourced from
     * joined messages row. Null for an external file.
     */
    discordMessageId: string | null;
    /**
     * Discord channel snowflake of the channel containing the originating message. Sourced from
     * joined messages row. Null for an external file.
     */
    discordChannelId: string | null;
}
