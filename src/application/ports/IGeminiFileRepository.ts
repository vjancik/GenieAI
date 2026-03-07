import type { GeminiFileUpload } from "../../domain/message/GeminiFileUpload.ts";

/**
 * Port interface for persisting Gemini file upload records.
 *
 * Each record tracks one Discord attachment that was uploaded to the Gemini
 * Files API. The `originalGeminiUrl` is immutable and serves as the stable
 * lookup key used when scanning LangChain message content blocks.
 */
export interface IGeminiFileRepository {
    /**
     * Persists a new Gemini file upload record.
     * On first upload `originalGeminiUrl` equals `geminiUrl`.
     *
     * @param record - All fields except `id` (assigned by the database)
     */
    save(record: Omit<GeminiFileUpload, "id">): Promise<GeminiFileUpload>;

    /**
     * Updates the current Gemini file name, URL, and upload timestamp for an
     * existing record after a refresh (re-upload with a new UUID file name).
     *
     * Identified by `originalGeminiUrl` which never changes.
     *
     * @param originalGeminiUrl - The immutable lookup key
     * @param update - The new file name, URL, and upload timestamp
     */
    updateAfterRefresh(
        originalGeminiUrl: string,
        update: Pick<
            GeminiFileUpload,
            "geminiFileName" | "geminiUrl" | "uploadedAt"
        >,
    ): Promise<void>;

    /**
     * Retrieves multiple records by their original Gemini URLs in a single query.
     * URLs not found in the database are silently omitted from the result.
     *
     * @param originalGeminiUrls - The stable lookup keys to query
     * @returns Map from originalGeminiUrl to the corresponding record
     */
    findByOriginalUrls(
        originalGeminiUrls: string[],
    ): Promise<Map<string, GeminiFileUpload>>;
}
