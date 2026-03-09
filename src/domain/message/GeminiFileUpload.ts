/**
 * Domain entity for an ephemeral per-key Gemini file upload record.
 *
 * Tracks the current Gemini Files API upload for a specific (file, api_key) pair.
 * One GeminiFile can have multiple GeminiFileUpload records — one per API key that
 * has accessed it. Since Gemini files are project-scoped, each key must maintain its
 * own upload of the same Discord attachment.
 *
 * Rows are automatically cleaned by a BEFORE INSERT trigger when `uploadedAt` is
 * older than 48 hours (the Gemini Files API TTL). After cleanup, the corresponding
 * GeminiFile anchor remains, allowing the refresh service to re-download from Discord
 * and re-upload for the current key without losing any context.
 *
 * `geminiFileName` uses a UUID-based name (`"files/<uuid>"`), guaranteeing global
 * uniqueness across keys and preventing UNIQUE constraint collisions when rows are
 * re-inserted after trigger cleanup.
 */
export interface GeminiFileUpload {
    /** UUID primary key */
    id: string;
    /** FK → GeminiFile.id — the permanent anchor with Discord context */
    geminiFileId: string;
    /** FK → GeminiApiKey.id — the key that owns this upload */
    apiKeyId: string;
    /**
     * The Gemini file name for the current upload (e.g. `"files/<uuid>"`).
     * UUID-based — globally unique across projects and keys.
     * Used to call `ai.files.delete()` before re-uploading.
     */
    geminiFileName: string;
    /** The current Gemini download URI. Replaced on re-upload. */
    geminiUrl: string;
    /** When the current Gemini file was uploaded. Used to evaluate staleness. */
    uploadedAt: Date;
}
