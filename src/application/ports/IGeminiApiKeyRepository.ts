import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

/**
 * Port interface for persisting and syncing Google API key records.
 *
 * Keys are synced from environment variables at startup via
 * {@link GeminiApiKeySyncService}. The repository provides idempotent upsert
 * semantics so the same key can be re-registered across restarts without errors.
 *
 * Keys are never hard-deleted — they are deactivated so their associated
 * `gemini_file_uploads` rows are preserved across key rotations.
 */
export interface IGeminiApiKeyRepository {
    /**
     * Inserts a new key record or updates `isPaid` and reactivates it if the
     * key already exists (including previously deactivated keys).
     * Keyed by the raw `apiKey` string (unique column).
     *
     * @param key - The key data to persist
     * @returns The saved record including the database-assigned UUID
     */
    upsert(key: Pick<GeminiApiKey, "apiKey" | "isPaid">): Promise<GeminiApiKey>;

    /**
     * Sets `isActive = false` for all key records whose `apiKey` is NOT in the
     * provided list. Keys are never hard-deleted — deactivation preserves their
     * associated `gemini_file_uploads` rows (upload records are project-scoped
     * and re-uploading files is expensive).
     *
     * Guards against an empty `apiKeys` array to prevent accidental full-table deactivation.
     *
     * @param apiKeys - The raw API key strings that should remain active
     */
    deactivateNotIn(apiKeys: string[]): Promise<void>;

    /**
     * Marks the given key as `lastUsed = true` and clears the flag from all
     * other keys in a single UPDATE. Used by {@link RoundRobinFreeKeyProvider}
     * to persist rotation position across restarts. Fire-and-forget — errors are
     * logged but not propagated.
     *
     * @param id - The UUID of the key to mark as last-used
     */
    setLastUsed(id: string): Promise<void>;
}
