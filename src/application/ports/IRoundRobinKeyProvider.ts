import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";

/**
 * Port for managing round-robin rotation of free-tier Google API keys.
 *
 * Maintains a cursor over the available free keys. The orchestrator uses this
 * to start with the current key on each invocation and advance to the next key
 * when a rate-limit error (HTTP 429) is encountered.
 *
 * State is shared across concurrent requests — if one request advances the
 * cursor, subsequent requests start from the new current key, distributing load
 * across keys over time.
 */
export interface IRoundRobinKeyProvider {
    /** The currently active free API key. */
    readonly currentKey: GeminiApiKey;

    /**
     * Advances to the next key in round-robin order and returns it.
     * Mutates internal state — the next caller's `currentKey` will be this key.
     */
    nextKey(): GeminiApiKey;

    /** Total number of free API keys available. Used to bound retry loops. */
    readonly keyCount: number;
}
