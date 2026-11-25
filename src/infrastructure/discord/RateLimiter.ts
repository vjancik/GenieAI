import type { IRateLimiter, RateLimitResult, RateLimitWindow } from "../../application/ports/IRateLimiter.ts";
import { SlidingWindowLedger } from "./SlidingWindowLedger.ts";

/** Interval between full ledger sweeps to evict fully-expired keys. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sliding-window call-count rate limiter keyed by an arbitrary string (e.g. Discord user ID).
 *
 * Each key is evaluated against an ordered list of windows. A call is allowed only when
 * every window has capacity remaining, and only allowed calls are recorded, so denied calls
 * never extend the wait.
 *
 * Old timestamps are pruned lazily on each `check` call. Additionally, a periodic cleanup
 * sweeps the entire ledger once an hour to evict keys whose timestamps have all expired,
 * preventing unbounded memory growth from long-inactive users.
 *
 * An empty window list disables limiting: every call is allowed and nothing is recorded.
 */
export class RateLimiter implements IRateLimiter {
    private readonly ledger: SlidingWindowLedger;

    /**
     * @param windows - Ordered list of windows to enforce. All windows must pass for a call to be allowed.
     */
    constructor(windows: readonly RateLimitWindow[]) {
        this.ledger = new SlidingWindowLedger(windows);
        // unref() lets the process exit without waiting for this timer.
        setInterval(this.cleanup.bind(this), CLEANUP_INTERVAL_MS).unref();
    }

    /**
     * Records a call attempt for `key` and returns whether it is allowed.
     *
     * If any window is already at capacity the attempt is rejected and nothing is recorded.
     * On denial, `retryAfterMs` is the number of milliseconds until the oldest blocking
     * timestamp expires and the next call would be permitted.
     *
     * @param key - Identifier for the caller (e.g. Discord user ID)
     */
    check(key: string): RateLimitResult {
        const now = Date.now();
        const result = this.ledger.evaluate(key, now);
        // Each allowed call costs one unit, turning the weighted ledger into a call counter
        if (result.allowed) this.ledger.record(key, 1, now);
        return result;
    }

    /**
     * Removes all keys whose timestamps have entirely expired across all windows.
     * Called on a fixed interval — not needed for correctness, only for memory hygiene.
     */
    private cleanup(): void {
        this.ledger.sweep(Date.now());
    }
}
