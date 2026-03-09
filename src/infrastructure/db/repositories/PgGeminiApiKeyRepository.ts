import { notInArray } from "drizzle-orm";
import type { IGeminiApiKeyRepository } from "../../../application/ports/IGeminiApiKeyRepository.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../../domain/message/GeminiApiKey.ts";
import type { Db } from "../connection.ts";
import { geminiApiKeys } from "../schema.ts";

/**
 * PostgreSQL implementation of {@link IGeminiApiKeyRepository} using Drizzle ORM.
 *
 * Keys are upserted idempotently on startup via {@link GeminiApiKeySyncService}.
 * Keys removed from env are deactivated (not deleted) via {@link deactivateNotIn}
 * so their associated gemini_file_uploads rows are preserved across key rotations.
 */
export class PgGeminiApiKeyRepository implements IGeminiApiKeyRepository {
    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {}

    /**
     * Inserts a new key or, on conflict, updates `isPaid` and sets `isActive = true`.
     * The reactivation on conflict ensures a key that was previously deactivated
     * (removed from env) is treated as active again when it reappears.
     */
    async upsert(
        key: Pick<GeminiApiKey, "apiKey" | "isPaid">,
    ): Promise<GeminiApiKey> {
        try {
            const [result] = await this.db
                .insert(geminiApiKeys)
                .values({
                    apiKey: key.apiKey,
                    isPaid: key.isPaid,
                    isActive: true,
                })
                .onConflictDoUpdate({
                    target: geminiApiKeys.apiKey,
                    // Update isPaid so a key's type can be corrected by changing env vars.
                    // Always set isActive = true to reactivate a previously deactivated key.
                    set: { isPaid: key.isPaid, isActive: true },
                })
                .returning();

            if (!result) {
                throw new DatabaseError(
                    "Gemini API key upsert returned no result",
                );
            }

            this.logger.debug(
                { apiKeyId: result.id, isPaid: result.isPaid },
                "Upserted Gemini API key",
            );

            return {
                id: result.id,
                apiKey: result.apiKey,
                isPaid: result.isPaid,
            };
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError("Failed to upsert Gemini API key", err);
        }
    }

    /**
     * Deactivates all key records whose `apiKey` is NOT in the provided list by
     * setting `isActive = false`. Rows are never deleted — their associated
     * gemini_file_uploads rows are preserved so re-upload costs are avoided if
     * the key is re-added later.
     *
     * Guards against an empty `apiKeys` array to prevent accidental full-table deactivation.
     */
    async deactivateNotIn(apiKeys: string[]): Promise<void> {
        if (apiKeys.length === 0) {
            this.logger.error(
                "deactivateNotIn called with empty array — skipping to prevent full-table deactivation",
            );
            return;
        }

        try {
            await this.db
                .update(geminiApiKeys)
                .set({ isActive: false })
                .where(notInArray(geminiApiKeys.apiKey, apiKeys));

            this.logger.debug(
                { activeKeyCount: apiKeys.length },
                "Deactivated orphaned Gemini API key records",
            );
        } catch (err) {
            throw new DatabaseError(
                "Failed to deactivate orphaned Gemini API keys",
                err,
            );
        }
    }
}
