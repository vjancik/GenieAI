import type { IRoundRobinKeyProvider } from "../../application/ports/IRoundRobinKeyProvider.ts";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";

/**
 * {@link IRoundRobinKeyProvider} adapter for a single paid API key.
 *
 * Wraps a paid key so it can be passed to {@link invokeWithFreeKeyRotation} without
 * modification. There is only one key, so {@link nextKey} is a no-op that returns the
 * same key, and {@link keyCount} is always 1 (no retry loop on 429 — paid key exhaustion
 * is propagated immediately as a non-429 error or re-thrown as AllFreeKeysExhaustedError).
 */
export class SinglePaidKeyProvider implements IRoundRobinKeyProvider {
    constructor(private readonly key: GeminiApiKey) {}

    get currentKey(): GeminiApiKey {
        return this.key;
    }

    /** No rotation available — returns the same paid key. */
    nextKey(): GeminiApiKey {
        return this.key;
    }

    /** Always 1 — the rotation loop in invokeWithFreeKeyRotation runs exactly once. */
    get keyCount(): number {
        return 1;
    }
}
