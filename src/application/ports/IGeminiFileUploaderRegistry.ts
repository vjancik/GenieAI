import type { IGeminiFileUploader } from "./IGeminiFileUploader.ts";

/**
 * Port interface for a lazy-caching registry of Gemini file uploaders keyed by API key ID.
 *
 * Gemini files are project-scoped — a file uploaded with one API key is inaccessible
 * from another key's project. The registry ensures that each API key has its own
 * uploader instance, caching expensive construction (HTTP client, auth) per key.
 *
 * Used by {@link GeminiFileRefreshService} to retrieve the correct uploader for the
 * API key currently active during a model invocation.
 */
export interface IGeminiFileUploaderRegistry {
    /**
     * Returns the {@link IGeminiFileUploader} for the given API key UUID.
     * Creates and caches the uploader on first call for each key.
     *
     * @param apiKeyId - The database UUID of the API key (from `GeminiApiKey.id`)
     * @throws {@link AppError} with code `UPLOADER_NOT_FOUND` if no key with that ID is registered
     */
    get(apiKeyId: string): IGeminiFileUploader;
}
