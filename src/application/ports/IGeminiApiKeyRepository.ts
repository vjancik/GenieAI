import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

/**
 * Port interface for persisting and syncing Google API key records.
 *
 * Keys are synced from environment variables at startup via
 * {@link GeminiApiKeySyncService}. The repository provides idempotent upsert
 * semantics so the same key can be re-registered across restarts without errors.
 */
export interface IGeminiApiKeyRepository {
    /**
     * Inserts a new key record or updates `isPaid` if the key already exists.
     * Keyed by the raw `apiKey` string (unique column).
     *
     * @param key - The key data to persist
     * @returns The saved record including the database-assigned UUID
     */
    upsert(key: Pick<GeminiApiKey, "apiKey" | "isPaid">): Promise<GeminiApiKey>;

    /**
     * Deletes all key records whose `apiKey` is NOT in the provided list.
     * Used at startup to remove keys that have been removed from the environment.
     *
     * Guards against an empty `apiKeys` array to prevent accidental full-table deletion.
     *
     * @param apiKeys - The raw API key strings that should be retained
     */
    deleteNotIn(apiKeys: string[]): Promise<void>;
}
