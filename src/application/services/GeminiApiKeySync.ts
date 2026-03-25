import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";
import type { IGeminiApiKeyRepository } from "../ports/IGeminiApiKeyRepository.ts";
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
     * @param freeApiKeys - Raw free-tier key strings from `GOOGLE_FREE_API_KEYS`
     * @param paidApiKey - Raw paid key string from `GOOGLE_PAID_API_KEY`
     * @returns DB records for all keys, split into free and paid groups
     */
    async sync(
        freeApiKeys: string[],
        paidApiKey: string,
    ): Promise<{ freeKeys: GeminiApiKey[]; paidKey: GeminiApiKey }> {
        const allKeyStrings = [...freeApiKeys, paidApiKey];

        // Upsert all keys — free first, then paid
        // NOTE: Multiple queries preferred to single unnest() ARRAY query on process initialization
        const freeKeyRecords = await Promise.all(
            freeApiKeys.map((apiKey) => this.geminiApiKeyRepo.upsert({ apiKey, isPaid: false })),
        );
        const paidKeyRecord = await this.geminiApiKeyRepo.upsert({
            apiKey: paidApiKey,
            isPaid: true,
        });

        // Deactivate keys removed from env. Rows are kept (not deleted) so their
        // gemini_file_uploads rows survive, avoiding unnecessary re-uploads.
        await this.geminiApiKeyRepo.deactivateNotIn(allKeyStrings);

        this.logger.info(
            {
                freeKeyCount: freeKeyRecords.length,
                paidKeyId: paidKeyRecord.id,
            },
            "Gemini API keys synced",
        );

        return { freeKeys: freeKeyRecords, paidKey: paidKeyRecord };
    }
}
