import type { IWeightedRateLimiter, RateLimitResult, RateLimitWindow } from "../../application/ports/IRateLimiter.ts";
import { SlidingWindowLedger } from "./SlidingWindowLedger.ts";

/** Interval between full ledger sweeps to evict fully-expired keys. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sliding-window token rate limiter keyed by an arbitrary string (e.g. Discord user ID).
 *
 * A request's token cost is only known once the model has answered, so callers `check` before
 * running a request and `record` its (weighted) token usage afterwards. A key is denied once the
 * tokens recorded inside any window reach that window's limit; the request that crosses the limit
 * is still served, so a key can overshoot a window by at most one request.
 *
 * State lives in process memory and resets on restart. A periodic sweep evicts inactive keys.
 * An empty window list disables limiting.
 */
export class TokenRateLimiter implements IWeightedRateLimiter {
    private readonly ledger: SlidingWindowLedger;

    /**
     * @param windows - Token windows to enforce, where `limit` is the weighted token allowance per window.
     */
    constructor(windows: readonly RateLimitWindow[]) {
        this.ledger = new SlidingWindowLedger(windows);
        // unref() lets the process exit without waiting for this timer.
        setInterval(this.cleanup.bind(this), CLEANUP_INTERVAL_MS).unref();
    }

    check(key: string): RateLimitResult {
        return this.ledger.evaluate(key, Date.now());
    }

    record(key: string, weight: number): void {
        this.ledger.record(key, weight, Date.now());
    }

    /** Evicts keys whose usage has entirely expired. Memory hygiene only. */
    private cleanup(): void {
        this.ledger.sweep(Date.now());
    }
}
