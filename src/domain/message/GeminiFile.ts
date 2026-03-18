/**
 * Domain entity for a permanently anchored Gemini file record.
 *
 * Each row corresponds to one Discord attachment that was ever uploaded to the
 * Gemini Files API. This entity is NEVER deleted — it holds the immutable Discord
 * context (discordAttachmentId, discordFilename, messageId) needed to re-download
 * and re-upload the file if it must be refreshed for a different API key.
 *
 * `discordMessageId` and `discordChannelId` are NOT stored here — they are sourced
 * from the joined `messages` row (via `messageId` FK) at query time to avoid duplication.
 *
 * The `originalGeminiUrl` is the URI returned at the very first upload. It is
 * stored in LangChain content blocks as the stable lookup key and never changes,
 * even as the per-key upload records are rotated out by the stale cleanup trigger.
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
    /** Discord attachment snowflake — stable identifier for re-downloading from Discord CDN. */
    discordAttachmentId: string;
    /** Original filename as uploaded by the user in Discord. Used as displayName on re-upload. */
    discordFilename: string;
    /** UUID primary key of the messages row that originally created this upload. FK → messages(id). */
    messageId: string;
    /** Discord message snowflake of the message that originally uploaded this file. Sourced from joined messages row. */
    discordMessageId: string;
    /** Discord channel snowflake of the channel containing the originating message. Sourced from joined messages row. */
    discordChannelId: string;
}
