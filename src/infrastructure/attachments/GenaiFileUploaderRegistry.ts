import type { IGeminiFileUploaderRegistry } from "../../application/ports/IGeminiFileUploaderRegistry.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";
import { GenaiFileUploader } from "./GenaiFileUploader.ts";

/**
 * Lazy-caching registry of {@link GenaiFileUploader} instances, one per API key.
 *
 * Each API key belongs to a separate Gemini project — files uploaded with one
 * key are inaccessible from another. This registry ensures a dedicated uploader
 * (with its own GoogleGenAI client) exists per key, constructed on first access
 * and cached thereafter.
 *
 * Receives all known API keys at construction time via a `Map<apiKeyId, apiKeyString>`.
 * Clients are constructed lazily on `get()` rather than eagerly to avoid
 * unnecessary HTTP client initialization for keys that may never be used.
 */
export class GenaiFileUploaderRegistry implements IGeminiFileUploaderRegistry {
    private readonly cache = new Map<string, GenaiFileUploader>();
    /** Maps apiKeyId → raw API key string for lazy client construction. */
    private readonly keyMap: Map<string, string>;

    constructor(
        allKeys: GeminiApiKey[],
        private readonly logger: Logger,
    ) {
        this.keyMap = new Map(allKeys.map((k) => [k.id, k.apiKey]));
    }

    /**
     * Returns the uploader for the given API key UUID.
     * Constructs and caches it on first access.
     *
     * @throws {@link AppError} with code `UPLOADER_NOT_FOUND` if the key ID is not registered
     */
    get(apiKeyId: string): GenaiFileUploader {
        const cached = this.cache.get(apiKeyId);
        if (cached) return cached;

        const apiKey = this.keyMap.get(apiKeyId);
        if (!apiKey) {
            throw new AppError(
                "UPLOADER_NOT_FOUND",
                `No uploader registered for apiKeyId: ${apiKeyId}`,
            );
        }

        const uploader = new GenaiFileUploader(
            apiKey,
            apiKeyId,
            this.logger.child({ apiKeyId }),
        );
        this.cache.set(apiKeyId, uploader);
        this.logger.debug(
            { apiKeyId },
            "Constructed new GenaiFileUploader for API key",
        );
        return uploader;
    }
}
