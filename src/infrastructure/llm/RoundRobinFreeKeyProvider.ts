import type { IFreeKeyProvider } from "../../application/ports/IFreeKeyProvider.ts";
import { ConfigError } from "../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

/**
 * Round-robin implementation of {@link IFreeKeyProvider}.
 *
 * Maintains a cursor over the free API keys array. The cursor is shared across
 * concurrent requests — advancing it on a 429 in one request will cause subsequent
 * requests to start from the newly-active key, distributing load over time.
 *
 * The orchestrator loop calls {@link currentKey} on the first attempt, then
 * {@link nextKey} on each subsequent attempt until all keys have been tried.
 * {@link keyCount} bounds the retry loop.
 */
export class RoundRobinFreeKeyProvider implements IFreeKeyProvider {
    private currentIndex = 0;

    constructor(private readonly keys: GeminiApiKey[]) {
        if (keys.length === 0) {
            throw new ConfigError(
                "RoundRobinFreeKeyProvider requires at least one free API key",
            );
        }
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
     */
    nextKey(): GeminiApiKey {
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        return this.currentKey;
    }

    /** Total number of free API keys available. Used to bound retry loops. */
    get keyCount(): number {
        return this.keys.length;
    }
}
