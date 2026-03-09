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
 * Orphaned rows (keys removed from env) are pruned via {@link deleteNotIn}.
 */
export class PgGeminiApiKeyRepository implements IGeminiApiKeyRepository {
    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {}

    async upsert(
        key: Pick<GeminiApiKey, "apiKey" | "isPaid">,
    ): Promise<GeminiApiKey> {
        try {
            const [result] = await this.db
                .insert(geminiApiKeys)
                .values({ apiKey: key.apiKey, isPaid: key.isPaid })
                .onConflictDoUpdate({
                    target: geminiApiKeys.apiKey,
                    // Update isPaid so a key's type can be corrected by changing env vars
                    set: { isPaid: key.isPaid },
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

    async deleteNotIn(apiKeys: string[]): Promise<void> {
        // Guard against accidental full-table deletion when called with an empty array
        if (apiKeys.length === 0) {
            this.logger.error(
                "deleteNotIn called with empty array — skipping to prevent full-table deletion",
            );
            return;
        }

        try {
            await this.db
                .delete(geminiApiKeys)
                .where(notInArray(geminiApiKeys.apiKey, apiKeys));

            this.logger.debug(
                { retainedKeyCount: apiKeys.length },
                "Removed orphaned Gemini API key records",
            );
        } catch (err) {
            throw new DatabaseError(
                "Failed to delete orphaned Gemini API keys",
                err,
            );
        }
    }
}
