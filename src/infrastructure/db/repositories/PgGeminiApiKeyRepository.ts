import { eq, ne, sql } from "drizzle-orm";
import type { Logger } from "../../../application/types/Logger.ts";
import type { GeminiApiKey } from "../../../domain/entities/GeminiApiKey.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { IGeminiApiKeyRepository } from "../../../domain/ports/IGeminiApiKeyRepository.ts";
import type { Db } from "../connection.ts";
import { pgTextArray } from "../pgTextArray.ts";
import { geminiApiKeys } from "../schema.ts";

/**
 * Prepared statement: upsert a gemini_api_keys row by apiKey.
 *
 * Uses EXCLUDED.<col> in the conflict set so the query structure is fully static.
 * Always sets isActive = true to reactivate a previously deactivated key.
 */
function buildUpsertKeyStmt(db: Db) {
    return db
        .insert(geminiApiKeys)
        .values({
            apiKey: sql.placeholder("apiKey"),
            isPaid: sql.placeholder("isPaid"),
            isActive: true,
        })
        .onConflictDoUpdate({
            target: geminiApiKeys.apiKey,
            // Update isPaid so a key's type can be corrected by changing env vars.
            // Always set isActive = true to reactivate a previously deactivated key.
            set: {
                isPaid: sql`EXCLUDED.is_paid`,
                isActive: true,
            },
        })
        .returning({
            id: geminiApiKeys.id,
            apiKey: geminiApiKeys.apiKey,
            isPaid: geminiApiKeys.isPaid,
            lastUsed: geminiApiKeys.lastUsed,
        })
        .prepare("gemini_api_key_upsert");
}

/**
 * Prepared statement: deactivate all keys whose api_key is NOT in the provided list.
 *
 * Uses `!= ALL($keys)` instead of `NOT IN (...)` so the query structure is fixed
 * regardless of list size — a single `text[]` placeholder replaces the dynamic list.
 * At execute time, `keys` receives a {@link pgTextArray} value.
 */
function buildDeactivateNotInStmt(db: Db) {
    return db
        .update(geminiApiKeys)
        .set({ isActive: false })
        .where(ne(geminiApiKeys.apiKey, sql`ALL(${sql.placeholder("keys")})`))
        .prepare("gemini_api_key_deactivate_not_in");
}

/**
 * Prepared statement: clear lastUsed from all free keys then set it on the given id.
 *
 * Scoped to isPaid = false so paid keys are never touched.
 * Uses a CASE expression so all free-key rows are updated in a single pass:
 * each row either gets lastUsed = true (the target key) or lastUsed = false.
 * This avoids a two-step clear-then-set that could leave all keys false if
 * the process dies between the two statements.
 */
function buildSetLastUsedStmt(db: Db) {
    return db
        .update(geminiApiKeys)
        .set({ lastUsed: sql`${geminiApiKeys.id} = ${sql.placeholder("id")}` })
        .where(eq(geminiApiKeys.isPaid, false))
        .prepare("gemini_api_key_set_last_used");
}

/**
 * PostgreSQL implementation of {@link IGeminiApiKeyRepository} using Drizzle ORM.
 *
 * Keys are upserted on startup via {@link GeminiApiKeySyncService}.
 * Keys removed from env are deactivated (not deleted) via {@link deactivateNotIn}
 * so their associated gemini_file_uploads rows are preserved across key rotations.
 *
 * All queries use prepared statements cached on construction, reducing per-call
 * planning overhead. Dynamic array parameters use {@link pgTextArray} to produce
 * a `text[]` value compatible with `!= ALL($1)` without expanding the parameter list.
 */
export class PgGeminiApiKeyRepository implements IGeminiApiKeyRepository {
    private readonly stmtUpsertKey: ReturnType<typeof buildUpsertKeyStmt>;
    private readonly stmtDeactivateNotIn: ReturnType<typeof buildDeactivateNotInStmt>;
    private readonly stmtSetLastUsed: ReturnType<typeof buildSetLastUsedStmt>;

    constructor(
        db: Db,
        private readonly logger: Logger,
    ) {
        this.stmtUpsertKey = buildUpsertKeyStmt(db);
        this.stmtDeactivateNotIn = buildDeactivateNotInStmt(db);
        this.stmtSetLastUsed = buildSetLastUsedStmt(db);
    }

    /**
     * Inserts a new key or, on conflict, updates `isPaid` and sets `isActive = true`.
     * The reactivation on conflict ensures a key that was previously deactivated
     * (removed from env) is treated as active again when it reappears.
     */
    async upsert(key: Pick<GeminiApiKey, "apiKey" | "isPaid">): Promise<GeminiApiKey> {
        try {
            const [result] = await this.stmtUpsertKey.execute(key);

            if (!result) {
                throw new DatabaseError("Gemini API key upsert returned no result");
            }

            this.logger.debug({ apiKeyId: result.id, isPaid: result.isPaid }, "Upserted Gemini API key");

            return result;
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError("Failed to upsert Gemini API key", err);
        }
    }

    /**
     * Sets `lastUsed = true` on the given key and `lastUsed = false` on all others
     * in a single UPDATE pass. Used by {@link RoundRobinFreeKeyProvider} to persist
     * rotation position across restarts. Errors are logged and not re-thrown.
     */
    async setLastUsed(id: GeminiApiKey["id"]): Promise<void> {
        try {
            await this.stmtSetLastUsed.execute({ id });
            this.logger.debug({ apiKeyId: id }, "Marked Gemini API key as last-used");
        } catch (err) {
            this.logger.error({ err, apiKeyId: id }, "Failed to persist last-used Gemini API key");
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
    async deactivateNotIn(apiKeys: GeminiApiKey["apiKey"][]): Promise<void> {
        if (apiKeys.length === 0) {
            this.logger.error("deactivateNotIn called with empty array — skipping to prevent full-table deactivation");
            return;
        }

        try {
            await this.stmtDeactivateNotIn.execute({
                keys: pgTextArray(apiKeys),
            });

            this.logger.debug({ activeKeyCount: apiKeys.length }, "Deactivated orphaned Gemini API key records");
        } catch (err) {
            throw new DatabaseError("Failed to deactivate orphaned Gemini API keys", err);
        }
    }
}
