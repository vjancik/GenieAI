/**
 * Port interface for uploading files to the Gemini Files API.
 *
 * Placed in the application layer so the use case depends on an abstraction.
 * The concrete implementation lives in infrastructure and uses `@google/genai`.
 *
 * Gemini files expire after 48 hours. Callers are responsible for tracking
 * upload time and scheduling refreshes via {@link GeminiFileRefreshService}.
 */

/** The result of a successful Gemini file upload. */
export interface UploadedGeminiFile {
    /**
     * Gemini file name (e.g. `"files/<uuid>"`). Used to call
     * `ai.files.get()` and `ai.files.delete()`.
     */
    geminiFileName: string;
    /**
     * The Gemini download URI for use in LangChain content blocks.
     * Stored as the `url:` property of a multimodal content block.
     */
    geminiUrl: string;
}

export interface IGeminiFileUploader {
    /**
     * The database UUID of the API key used to construct this uploader.
     * Needed when persisting upload records — the uploader is always paired
     * with one specific API key's Gemini project.
     */
    readonly apiKeyId: string;

    /**
     * Uploads a file from disk to the Gemini Files API and waits until it
     * reaches ACTIVE state before returning.
     *
     * The caller is responsible for deleting the temp file after this returns.
     *
     * @param filePath - Absolute path to the file on disk
     * @param fileName - The Gemini file name to use (e.g. `"files/<uuid>"`).
     *                   Must be unique; generate a fresh UUID for each upload.
     * @param mimeType - MIME type of the file
     * @param displayName - Human-readable filename shown in the Gemini console
     * @throws {@link AppError} with code `GEMINI_UPLOAD_FAILED` if the upload
     *         or processing fails, or times out waiting for ACTIVE state.
     */
    upload(filePath: string, fileName: string, mimeType: string, displayName: string): Promise<UploadedGeminiFile>;

    /**
     * Uploads a `ReadableStream<Uint8Array>` directly to the Gemini Files API,
     * bypassing the temp-file write, and waits until the file reaches ACTIVE state.
     *
     * @param stream - The byte stream to upload
     * @param fileName - The Gemini file name to use (e.g. `"files/<uuid>"`)
     * @param mimeType - MIME type of the file
     * @param displayName - Human-readable filename shown in the Gemini console
     * @param byteLength - Total byte length of the stream (required by the resumable protocol)
     * @throws {@link AppError} with code `GEMINI_UPLOAD_FAILED` if the upload
     *         or processing fails, or times out waiting for ACTIVE state.
     */
    uploadStream(
        stream: ReadableStream<Uint8Array>,
        fileName: string,
        mimeType: string,
        displayName: string,
        byteLength: number,
    ): Promise<UploadedGeminiFile>;

    /**
     * Deletes a Gemini file by its file name.
     * Silently ignores not-found errors (the file may already have expired).
     *
     * @param geminiFileName - The Gemini file name (e.g. `"files/<uuid>"`)
     */
    deleteFile(geminiFileName: string): Promise<void>;
}
