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
     * Saves a permanent file anchor with Discord metadata.
     *
     * Idempotent on `originalGeminiUrl` — if a file with the same original URL
     * already exists, returns the existing record without error. This handles
     * rare race conditions where the same attachment is uploaded twice.
     *
     * @param record - All fields except `id` (assigned by the database)
     * @returns The saved (or existing) GeminiFile record
     */
    saveFile(record: Omit<GeminiFile, "id">): Promise<GeminiFile>;

    /**
     * LEFT JOINs `gemini_files` with `gemini_file_uploads` for the given original
     * URLs and API key. Always returns a GeminiFile entry (discord context); the
     * upload field is null if no upload record exists for the specified API key
     * (e.g. first use of this key, or trigger-cleaned stale rows).
     *
     * @param originalUrls - The stable lookup keys stored in LangChain content blocks
     * @param apiKeyId - The API key whose upload records to join against
     * @returns Map from originalGeminiUrl to { file, upload } pair
     */
    findWithUploadStateForKey(
        originalUrls: string[],
        apiKeyId: string,
    ): Promise<Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>>;

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
     * @returns The saved/updated record
     */
    upsertUpload(record: Omit<GeminiFileUpload, "id">): Promise<GeminiFileUpload>;
}
