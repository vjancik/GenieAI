import type { GeminiFile } from "../../domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../domain/message/GeminiFileUpload.ts";

/**
 * Port interface for persisting Gemini file anchors and per-key upload records.
 *
 * Manages two related tables:
 * - `gemini_files`: permanent anchors with Discord context (never deleted)
 * - `gemini_file_uploads`: ephemeral per-key upload tracking (cleaned by trigger)
 *
 * The two-table design ensures that Discord context (needed to re-download and
 * re-upload) is never lost when stale upload rows are purged by the trigger.
 */
export interface IGeminiFileRepository {
    /**
     * Looks up gemini_files anchors by their stable `original_gemini_url` (discord:// token URLs)
     * and LEFT JOINs the upload record for the given API key.
     *
     * Used for the token block path in normalization — the common case.
     * Upload is null when no record exists for the given API key.
     *
     * @param originalUrls - discord:// stable anchor keys from token blocks
     * @param apiKeyId - The API key whose upload record to join
     * @returns Map keyed by `original_gemini_url`
     */
    findByOriginalUrl(
        originalUrls: string[],
        apiKeyId: string,
    ): Promise<Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>>;

    /**
     * Looks up gemini_files anchors by a known Gemini upload URL, and LEFT JOINs the
     * upload record for the given API key (which may differ from the key that produced
     * the URL being looked up).
     *
     * Used for the fileUri block path — already-resolved blocks whose anchor key is
     * unknown, only the Gemini URL is available. The url-match join is not filtered by
     * apiKeyId so the anchor can be found regardless of which key originally uploaded it.
     *
     * @param geminiUrls - raw Gemini URIs from already-resolved fileUri blocks
     * @param apiKeyId - The API key whose current upload record to join (may be null)
     * @returns Map keyed by the matched `gemini_url`
     */
    findByUploadUrl(
        geminiUrls: string[],
        apiKeyId: string,
    ): Promise<Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>>;

    /**
     * Batch-saves permanent file anchors with Discord metadata.
     *
     * ON CONFLICT (original_gemini_url) DO UPDATE SET id = gemini_files.id (no-op)
     * ensures `.returning()` always yields all rows — including pre-existing ones —
     * so callers never need a fallback SELECT per row.
     *
     * `discordMessageId` and `discordChannelId` are intentionally excluded — they are
     * not stored on `gemini_files` and are sourced from the joined `messages` row at read time.
     *
     * @param records - All fields except `id` (assigned by the database)
     * @returns The DB-assigned UUIDs, index-aligned with the input array
     */
    saveFiles(records: Omit<GeminiFile, "id" | "discordMessageId" | "discordChannelId">[]): Promise<{ id: string }[]>;

    /**
     * Inserts or updates the upload record for a (geminiFileId, apiKeyId) pair.
     *
     * ON CONFLICT (gemini_file_id, api_key_id) DO UPDATE SET:
     *   gemini_file_name = EXCLUDED.gemini_file_name,
     *   gemini_url       = EXCLUDED.gemini_url,
     *   uploaded_at      = EXCLUDED.uploaded_at
     *
     * Used both for initial uploads and for refreshes (re-uploads with new URLs).
     *
     * @param record - All fields except `id` (assigned by the database)
     */
    upsertUpload(record: Omit<GeminiFileUpload, "id">): Promise<void>;

    /**
     * Batch inserts or updates upload records for multiple (geminiFileId, apiKeyId) pairs.
     *
     * Applies the same ON CONFLICT logic as {@link upsertUpload} for each row.
     *
     * @param records - All fields except `id` (assigned by the database)
     */
    upsertUploads(records: Omit<GeminiFileUpload, "id">[]): Promise<void>;
}
