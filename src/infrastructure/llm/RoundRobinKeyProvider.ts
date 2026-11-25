import type { IRoundRobinKeyProvider, RotatableKey } from "../../application/ports/IRoundRobinKeyProvider.ts";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import { ConfigError } from "../../domain/errors/AppError.ts";
import type { IGeminiApiKeyRepository } from "../../domain/ports/IGeminiApiKeyRepository.ts";

/** Persists the rotation cursor so it can be resumed after a restart. */
type KeyCursorStore = Pick<IGeminiApiKeyRepository, "setLastUsed">;

/** A key that can resume rotation from a persisted cursor (see `cursorStore`). */
type ResumableKey = RotatableKey & { readonly lastUsed?: boolean };

/**
 * Round-robin implementation of {@link IRoundRobinKeyProvider}, used for the free and the paid
 * Google key pool, and for the Tavily key pool.
 *
 * Maintains a cursor over the pool's API keys. The cursor is shared across concurrent requests,
 * so advancing it when a key is rejected in one request causes subsequent requests to start
 * from the newly-active key, distributing load over time.
 *
 * The invoker loop reads {@link currentKey} on each attempt and calls {@link nextKey} when the
 * key is rejected, until all keys have been tried. {@link keyCount} bounds the retry loop.
 *
 * Cursor persistence is opt-in through `cursorStore`:
 * - With a store, the cursor is initialized from the `lastUsed` flag so that rotation resumes
 *   where it left off across process restarts, and every {@link nextKey} call persists the new
 *   key (fire-and-forget, errors are logged inside the store and do not affect key selection).
 * - Without a store, the cursor starts at the first key on every start, respecting the order
 *   the keys were configured in, and nothing is persisted.
 *
 * NOTE: the `gemini_api_keys.last_used` flag backing the store can only track ONE provider
 * instance's cursor (the free pool's, see {@link IGeminiApiKeyRepository.setLastUsed}). Passing
 * a store to a second instance would make the two overwrite each other's position; the schema
 * and the repository query need to be extended first.
 */
export class RoundRobinKeyProvider<TKey extends ResumableKey = GeminiApiKey> implements IRoundRobinKeyProvider<TKey> {
    private currentIndex: number;

    /**
     * @param keys        - The pool's keys in rotation order; an empty pool is only rejected on use
     * @param cursorStore - Enables resuming the cursor across restarts; omit to always start from
     *                      the first key
     */
    constructor(
        private readonly keys: TKey[],
        private readonly cursorStore?: KeyCursorStore,
    ) {
        // Resume from the key that was last used before shutdown.
        // If none is marked (all lastUsed = false), start from index 0.
        const lastUsedIndex = cursorStore ? keys.findIndex((k) => k.lastUsed) : -1;
        this.currentIndex = lastUsedIndex === -1 ? 0 : lastUsedIndex;
    }

    /**
     * The currently active API key (index-stable until {@link nextKey} is called).
     *
     * @throws {ConfigError} if the pool is empty. Deferred to first use rather than construction
     *         because a pool that no agent node is configured to use is legitimately empty.
     */
    get currentKey(): TKey {
        // nextKey wraps via modulo, so the index only misses when the pool is empty
        const key = this.keys[this.currentIndex];
        if (!key) throw new ConfigError("RoundRobinKeyProvider has no API keys to provide");
        return key;
    }

    /**
     * Advances the cursor to the next key in round-robin order and returns it.
     * Mutates shared state — the next caller's {@link currentKey} will be this key.
     * Persists the new key as last-used when a cursor store is configured (fire-and-forget).
     */
    nextKey(): TKey {
        // Math.max guards the modulo against an empty pool, leaving currentKey to report it
        this.currentIndex = (this.currentIndex + 1) % Math.max(this.keys.length, 1);
        const key = this.currentKey;
        // Fire-and-forget: persist rotation position for restart resume.
        this.cursorStore?.setLastUsed(key.id);
        return key;
    }

    /** Total number of API keys in the pool. Used to bound retry loops. */
    get keyCount(): number {
        return this.keys.length;
    }
}
