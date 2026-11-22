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
