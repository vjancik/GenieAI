import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import type { IGeminiApiKeyRepository } from "../../domain/ports/IGeminiApiKeyRepository.ts";
import type { Logger } from "../types/Logger.ts";

/**
 * Application service that keeps the `gemini_api_keys` DB table in sync with
 * the API keys configured in environment variables.
 *
 * Run once at startup before any LLM or file-upload operations. Ensures each
 * key has a stable UUID that can be used as a foreign key in `gemini_file_uploads`.
 *
 * Keys removed from env are deactivated (not deleted) so their associated
 * upload records are preserved — Gemini files are project-scoped and re-uploading
 * is expensive. If a key reappears in env it is automatically reactivated.
 * Keys already in the DB are upserted idempotently so restarts don't produce
 * duplicate rows.
 */
export class GeminiApiKeySyncService {
    constructor(
        private readonly geminiApiKeyRepo: IGeminiApiKeyRepository,
        private readonly logger: Logger,
    ) {}

    /**
     * Upserts all configured API keys and deactivates any orphaned DB rows.
     *
     * Either param may be `null` when the corresponding env var is absent.
     * `validateConfig` ensures the required keys are present for the configured
     * node `apiKeyType`s before this method is called.
     *
     * @param freeApiKeys - Raw free-tier key strings from `GOOGLE_FREE_API_KEYS`, or null if unset
     * @param paidApiKeys - Raw paid key strings from `GOOGLE_PAID_API_KEYS`, or null if unset
     * @returns DB records for all keys, split into free and paid groups, each in the given order
     */
    async sync(
        freeApiKeys: string[] | null,
        paidApiKeys: string[] | null,
    ): Promise<{ freeKeys: GeminiApiKey[]; paidKeys: GeminiApiKey[] }> {
        const allKeyStrings: string[] = [...(freeApiKeys ?? []), ...(paidApiKeys ?? [])];

        // Upsert all keys — free first, then paid
        // NOTE: Multiple queries preferred to single unnest() ARRAY query on process initialization
        const freeKeyRecords = await Promise.all(
            (freeApiKeys ?? []).map((apiKey) => this.geminiApiKeyRepo.upsert({ apiKey, isPaid: false })),
        );
        const paidKeyRecords = await Promise.all(
            (paidApiKeys ?? []).map((apiKey) => this.geminiApiKeyRepo.upsert({ apiKey, isPaid: true })),
        );

        // Deactivate keys removed from env. Rows are kept (not deleted) so their
        // gemini_file_uploads rows survive, avoiding unnecessary re-uploads.
        await this.geminiApiKeyRepo.deactivateNotIn(allKeyStrings);

        this.logger.info(
            {
                freeKeyCount: freeKeyRecords.length,
                paidKeyCount: paidKeyRecords.length,
            },
            "Gemini API keys synced",
        );

        return { freeKeys: freeKeyRecords, paidKeys: paidKeyRecords };
    }
}
