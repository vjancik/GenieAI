/** A single rate-limit window: at most `limit` calls within any `windowMs` milliseconds. */
export interface RateLimitWindow {
    /** Duration of the sliding window in milliseconds. */
    windowMs: number;
    /** Maximum number of calls allowed within the window. */
    limit: number;
}

/** Outcome of a rate-limit check. `retryAfterMs` is the wait until the next call would be allowed. */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Port for a per-key call rate limiter (e.g. keyed by chat user ID). */
export interface IRateLimiter {
    /**
     * Records a call attempt for `key` and returns whether it is allowed.
     * A denied attempt is not recorded, so it never extends the caller's wait.
     *
     * @param key - Identifier for the caller (e.g. a chat user ID)
     */
    check(key: string): RateLimitResult;
}

/**
 * Port for a per-key weighted rate limiter whose cost is only known after the guarded work runs
 * (e.g. LLM tokens). Checking and recording are separate: a caller checks before the work and
 * records its weight afterwards, so a single request may overshoot a window by its own weight.
 */
export interface IWeightedRateLimiter {
    /**
     * Returns whether `key` still has capacity in every window. Records nothing.
     *
     * @param key - Identifier for the caller (e.g. a chat user ID)
     */
    check(key: string): RateLimitResult;

    /**
     * Records `weight` units of usage for `key` at the current time.
     *
     * @param key - Identifier for the caller (e.g. a chat user ID)
     * @param weight - Usage to charge; non-positive weights are ignored
     */
    record(key: string, weight: number): void;
}
