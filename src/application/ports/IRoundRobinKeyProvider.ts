import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";

/**
 * Port for managing round-robin rotation over a pool of Google API keys (free or paid).
 *
 * Maintains a cursor over the pool's keys. The invoker uses this to start with the
 * current key on each invocation and advance to the next key when the current one is
 * rejected (HTTP 401, 402, 403) or rate-limited (HTTP 429).
 *
 * State is shared across concurrent requests — if one request advances the
 * cursor, subsequent requests start from the new current key, distributing load
 * across keys over time.
 */
export interface IRoundRobinKeyProvider {
    /** The currently active API key. */
    readonly currentKey: GeminiApiKey;

    /**
     * Advances to the next key in round-robin order and returns it.
     * Mutates internal state — the next caller's `currentKey` will be this key.
     */
    nextKey(): GeminiApiKey;

    /** Total number of API keys in the pool. Used to bound retry loops. */
    readonly keyCount: number;
}
