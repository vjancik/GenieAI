/**
 * Domain entity for a permanently anchored Gemini file record.
 *
 * Each row corresponds to one Discord attachment that was ever uploaded to the
 * Gemini Files API. This entity is NEVER deleted — it holds the immutable Discord
 * context (discordAttachmentId, discordFilename, messageDiscordId) needed to
 * re-download and re-upload the file if it must be refreshed for a different API key.
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
    /** Discord message snowflake of the message that originally uploaded this file. */
    messageDiscordId: string;
}
