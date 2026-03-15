/**
 * Sliding-window rate limiter keyed by an arbitrary string (e.g. Discord user ID).
 *
 * Each key is evaluated against an ordered list of windows. A call is allowed only when
 * every window has capacity remaining. When any window is exhausted the call is denied
 * and no state is mutated, keeping timestamps accurate for the next check.
 *
 * Old timestamps are pruned lazily on each `check` call. Additionally, a periodic cleanup
 * sweeps the entire map once an hour to evict keys whose timestamps have all expired,
 * preventing unbounded memory growth from long-inactive users.
 */

/** A single rate-limit window: max `limit` calls within `windowMs` milliseconds. */
export interface RateLimitWindow {
    /** Duration of the sliding window in milliseconds. */
    windowMs: number;
    /** Maximum number of calls allowed within the window. */
    limit: number;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Interval between full map sweeps to evict fully-expired keys. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class RateLimiter {
    /** Per-key list of call timestamps (epoch ms) — pruned lazily on each check. */
    private readonly timestamps = new Map<string, number[]>();

    /**
     * @param windows - Ordered list of windows to enforce. All windows must pass for a call to be allowed.
     */
    constructor(private readonly windows: RateLimitWindow[]) {
        // Sweep once an hour to evict keys that have had no activity within the longest window.
        // unref() lets the process exit without waiting for this timer.
        setInterval(this.cleanup.bind(this), CLEANUP_INTERVAL_MS).unref();
    }

    /**
     * Records a call attempt for `key` and returns whether it is allowed.
     *
     * If any window is already at capacity the attempt is rejected and no timestamp is
     * recorded, so the window expiry is not artificially extended by denied calls.
     * On denial, `retryAfterMs` is the number of milliseconds until the oldest blocking
     * timestamp expires and the next call would be permitted.
     *
     * @param key - Identifier for the caller (e.g. Discord user ID)
     */
    check(key: string): RateLimitResult {
        const now = Date.now();
        const history = this.timestamps.get(key) ?? [];

        // Determine the oldest window so we can prune everything before it in one pass
        const maxWindowMs = Math.max(...this.windows.map((w) => w.windowMs));
        const cutoff = now - maxWindowMs;
        const pruned = history.filter((t) => t > cutoff);

        // Check every window before mutating state — deny without recording if any is full.
        // Track the earliest unblock time across all violated windows.
        let retryAfterMs = 0;
        for (const { windowMs, limit } of this.windows) {
            const windowCutoff = now - windowMs;
            const inWindow = pruned.filter((t) => t > windowCutoff);
            if (inWindow.length >= limit) {
                // The oldest timestamp in this window expires at timestamp + windowMs.
                // Sorting ascending and taking index 0 gives the earliest one.
                const oldestInWindow = Math.min(...inWindow);
                const windowRetryAfterMs = oldestInWindow + windowMs - now;
                retryAfterMs = Math.max(retryAfterMs, windowRetryAfterMs);
            }
        }

        if (retryAfterMs > 0) {
            return { allowed: false, retryAfterMs };
        }

        pruned.push(now);
        this.timestamps.set(key, pruned);
        return { allowed: true };
    }

    /**
     * Removes all keys whose timestamps have entirely expired across all windows.
     * Called on a fixed interval — not needed for correctness, only for memory hygiene.
     */
    private cleanup(): void {
        const now = Date.now();
        const maxWindowMs = Math.max(...this.windows.map((w) => w.windowMs));
        const cutoff = now - maxWindowMs;
        for (const [key, history] of this.timestamps) {
            if (history.every((t) => t <= cutoff)) {
                this.timestamps.delete(key);
            }
        }
    }
}
