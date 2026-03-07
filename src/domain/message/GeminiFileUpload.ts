/**
 * Domain entity for a file that has been uploaded to the Gemini Files API.
 *
 * Each row tracks one Discord attachment that was uploaded to Gemini.
 * The `originalGeminiUrl` is immutable — it is the URI returned at first upload
 * and is stored in the message's LangChain content block. It serves as the stable
 * lookup key so that `langchain_messages` never needs to be mutated in the DB.
 *
 * `geminiFileName` and `geminiUrl` are updated on each refresh (when the 48-hour
 * TTL is approaching). A new UUID is generated and used as the file name on each
 * re-upload, so the `UNIQUE` constraint on `geminiFileName` is safe.
 */
export interface GeminiFileUpload {
    /** UUID primary key */
    id: string;
    /**
     * The Gemini file URI returned at first upload (e.g.
     * `"https://generativelanguage.googleapis.com/v1beta/files/<uuid>"`).
     * Immutable — stored in content blocks and used as the stable lookup key.
     */
    originalGeminiUrl: string;
    /**
     * The Gemini file name for the current upload (e.g. `"files/<uuid>"`).
     * Changes on each refresh. Used to call `ai.files.delete()` before re-uploading.
     */
    geminiFileName: string;
    /** The current Gemini download URI. Changes on each refresh. */
    geminiUrl: string;
    /** When the current Gemini file was uploaded. Used to evaluate staleness. */
    uploadedAt: Date;
    /** Discord attachment snowflake — stable identifier for the original attachment. */
    discordAttachmentId: string;
    /** Original filename as uploaded by the user in Discord. */
    discordFilename: string;
    /** Discord message snowflake of the message that originally uploaded this file. */
    messageDiscordId: string;
}
