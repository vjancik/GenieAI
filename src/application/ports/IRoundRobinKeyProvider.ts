import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";

/** The least a key needs to take part in rotation: a stable id, safe to log in place of the key. */
export interface RotatableKey {
    readonly id: string;
}

/**
 * Port for managing round-robin rotation over a pool of API keys, e.g. the free or paid Google
 * key pool, or the Tavily key pool.
 *
 * Maintains a cursor over the pool's keys. Callers use this to start with the current key on
 * each invocation and advance to the next key when the current one is rejected or rate-limited
 * (see `runWithKeyRotation`).
 *
 * State is shared across concurrent requests — if one request advances the
 * cursor, subsequent requests start from the new current key, distributing load
 * across keys over time.
 *
 * @template TKey - The pool's key type
 */
export interface IRoundRobinKeyProvider<TKey extends RotatableKey = GeminiApiKey> {
    /** The currently active API key. */
    readonly currentKey: TKey;

    /**
     * Advances to the next key in round-robin order and returns it.
     * Mutates internal state — the next caller's `currentKey` will be this key.
     */
    nextKey(): TKey;

    /** Total number of API keys in the pool. Used to bound retry loops. */
    readonly keyCount: number;
}
