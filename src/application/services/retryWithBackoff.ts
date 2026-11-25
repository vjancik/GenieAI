import { sleep } from "bun";

/** How often and how patiently {@link retryWithBackoff} retries. */
export interface RetryOptions {
    /** Retries after the first attempt; 0 disables retrying. */
    maxRetries: number;
    /** Delay before the first retry (ms); each further retry waits twice as long as the previous one. */
    initialDelayMs: number;
}

/** Collaborators of {@link retryWithBackoff}, separate from the policy so tests can substitute them. */
interface RetryHooks {
    /** Decides whether a failure is transient and worth another attempt. */
    isRetryable: (err: unknown) => boolean;
    /** Called before waiting out each retry's delay, e.g. to log the failure. `retry` counts from 1. */
    onRetry?: (err: unknown, retry: number, delayMs: number) => void;
    /** Waits out a delay; defaults to Bun's `sleep`. */
    sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Notes the retries that preceded a failure, for its error message, e.g. " after 2 retries";
 * empty for a first attempt.
 *
 * @param retry - The retries so far, as passed to a {@link retryWithBackoff} operation
 */
export function retriesNote(retry: number): string {
    if (retry === 0) return "";
    return ` after ${retry} ${retry === 1 ? "retry" : "retries"}`;
}

/**
 * Runs `operation`, retrying it with exponential backoff while it fails with a retryable error.
 * The n-th retry waits `initialDelayMs * 2^(n-1)` ms.
 *
 * @param operation - The operation to run; called once per attempt with the number of retries so
 *                    far (0 for the first attempt), e.g. to note them in its error
 * @param options   - The retry policy
 * @param hooks     - The retryability check, and optional retry callback and sleep function
 * @returns The first successful attempt's result
 * @throws The error of the first non-retryable failure, or of the last attempt once the retries
 *   are used up
 */
export async function retryWithBackoff<T>(
    operation: (retry: number) => Promise<T>,
    options: RetryOptions,
    { isRetryable, onRetry, sleepFn = sleep }: RetryHooks,
): Promise<T> {
    for (let retry = 0; ; retry++) {
        try {
            return await operation(retry);
        } catch (err) {
            if (retry >= options.maxRetries || !isRetryable(err)) throw err;

            const delayMs = options.initialDelayMs * 2 ** retry;
            onRetry?.(err, retry + 1, delayMs);
            await sleepFn(delayMs);
        }
    }
}
