import type { IRoundRobinKeyProvider, RotatableKey } from "../ports/IRoundRobinKeyProvider.ts";

/**
 * Outcome of one attempt with a single key. A key that is rejected or rate-limited is reported
 * as unusable rather than thrown, so that rotation is decided in one place; any other failure
 * should be thrown, ending the rotation.
 */
export type KeyAttemptResult<T> = { kind: "success"; value: T } | { kind: "keyUnusable"; error: unknown };

/** Outcome of {@link runWithKeyRotation}. */
type KeyRotationResult<TKey, T> =
    | { kind: "success"; value: T; key: TKey; attemptCount: number }
    | { kind: "exhausted"; lastError: unknown };

/**
 * Runs `attempt` with the pool's current key, rotating to the next key whenever the attempt
 * reports the key unusable, until an attempt succeeds or every key has been tried once.
 *
 * The cursor is shared by concurrent requests, so each attempt reads the live current key, and
 * the cursor is only advanced when no concurrent request has already advanced it past the key
 * that failed — otherwise the next key would be skipped without being tried.
 *
 * @param keyProvider - The key pool; its key count bounds the number of attempts
 * @param attempt     - Runs the operation with one key; `attemptIndex` counts from 0
 * @returns The successful attempt's value with the key that produced it, or the last key's error
 *   when every key was unusable (`lastError` is undefined for an empty pool)
 */
export async function runWithKeyRotation<TKey extends RotatableKey, T>(
    keyProvider: IRoundRobinKeyProvider<TKey>,
    attempt: (key: TKey, attemptIndex: number) => Promise<KeyAttemptResult<T>>,
): Promise<KeyRotationResult<TKey, T>> {
    let lastError: unknown;

    for (let attemptIndex = 0; attemptIndex < keyProvider.keyCount; attemptIndex++) {
        const key = keyProvider.currentKey;
        const result = await attempt(key, attemptIndex);
        if (result.kind === "success") {
            return { kind: "success", value: result.value, key, attemptCount: attemptIndex + 1 };
        }

        lastError = result.error;
        if (keyProvider.currentKey.id === key.id) keyProvider.nextKey();
    }

    return { kind: "exhausted", lastError };
}
