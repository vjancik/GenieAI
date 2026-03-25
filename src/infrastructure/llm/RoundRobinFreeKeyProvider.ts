import type { IGeminiApiKeyRepository } from "../../application/ports/IGeminiApiKeyRepository.ts";
import type { IRoundRobinKeyProvider } from "../../application/ports/IRoundRobinKeyProvider.ts";
import { ConfigError } from "../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

/**
 * Round-robin implementation of {@link IRoundRobinKeyProvider}.
 *
 * Maintains a cursor over the free API keys array. The cursor is shared across
 * concurrent requests — advancing it on a 429 in one request will cause subsequent
 * requests to start from the newly-active key, distributing load over time.
 *
 * The orchestrator loop calls {@link currentKey} on the first attempt, then
 * {@link nextKey} on each subsequent attempt until all keys have been tried.
 * {@link keyCount} bounds the retry loop.
 *
 * The cursor is initialised from the `lastUsed` flag in the DB so that rotation
 * resumes from where it left off across process restarts. On each {@link nextKey}
 * call the new key's ID is persisted back via {@link IGeminiApiKeyRepository.setLastUsed}
 * (fire-and-forget — errors are logged inside the repo and do not affect key selection).
 */
export class RoundRobinFreeKeyProvider implements IRoundRobinKeyProvider {
    private currentIndex: number;

    constructor(
        private readonly keys: GeminiApiKey[],
        private readonly repo: IGeminiApiKeyRepository,
    ) {
        if (keys.length === 0) {
            throw new ConfigError("RoundRobinFreeKeyProvider requires at least one free API key");
        }

        // Resume from the key that was last used before shutdown.
        // If none is marked (all lastUsed = false), start from index 0.
        const lastUsedIndex = keys.findIndex((k) => k.lastUsed);
        this.currentIndex = lastUsedIndex === -1 ? 0 : lastUsedIndex;
    }

    /** The currently active free API key (index-stable until {@link nextKey} is called). */
    get currentKey(): GeminiApiKey {
        // TYPE COERCION: TypeScript cannot statically prove the array is non-empty after
        // the constructor guard, so `keys[currentIndex]` is `GeminiApiKey | undefined`.
        // The constructor guarantees at least one key and nextKey wraps via modulo,
        // so `currentIndex` always points to a valid element.
        return this.keys[this.currentIndex] as GeminiApiKey;
    }

    /**
     * Advances the cursor to the next key in round-robin order and returns it.
     * Mutates shared state — the next caller's {@link currentKey} will be this key.
     * Persists the new key as last-used in the DB (fire-and-forget).
     */
    nextKey(): GeminiApiKey {
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        // Fire-and-forget: persist rotation position for restart resume.
        this.repo.setLastUsed(this.currentKey.id);
        return this.currentKey;
    }

    /** Total number of free API keys available. Used to bound retry loops. */
    get keyCount(): number {
        return this.keys.length;
    }
}
