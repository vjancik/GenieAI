import type { RateLimitResult, RateLimitWindow } from "../../application/ports/IRateLimiter.ts";

/** A single recorded usage: `weight` units charged at epoch-ms `at`. */
type LedgerEntry = { at: number; weight: number };

/**
 * Per-key sliding-window usage ledger shared by the rate limiters.
 *
 * Each key holds a chronological list of weighted entries. A key is over a window when the
 * summed weight of its entries inside that window reaches the window's limit. A count-based
 * limiter records weight 1 per call; a token limiter records the tokens a request consumed.
 *
 * Entries are appended in call order with `Date.now()`-derived timestamps, so each key's list
 * is assumed to be sorted ascending by `at`. An empty window list disables the ledger: every
 * evaluation passes and nothing is recorded.
 */
export class SlidingWindowLedger {
    /** Per-key chronological usage entries — pruned lazily on each evaluation. */
    private readonly entries = new Map<string, LedgerEntry[]>();
    /** Longest configured window; entries older than this can never matter again. */
    private readonly maxWindowMs: number;

    /**
     * @param windows - Windows to enforce. All windows must have capacity for an evaluation to pass.
     */
    constructor(private readonly windows: readonly RateLimitWindow[]) {
        this.maxWindowMs = windows.length > 0 ? Math.max(...windows.map((w) => w.windowMs)) : 0;
    }

    /** True when no windows are configured, i.e. limiting is disabled. */
    get isDisabled(): boolean {
        return this.windows.length === 0;
    }

    /**
     * Returns whether `key` has capacity left in every window at time `now`, without recording.
     *
     * On denial, `retryAfterMs` is the longest wait across the exhausted windows until enough of
     * the oldest entries slide out for that window's summed weight to drop below its limit.
     */
    evaluate(key: string, now: number): RateLimitResult {
        if (this.isDisabled) return { allowed: true };

        const live = this.prune(key, now);

        let retryAfterMs = 0;
        for (const { windowMs, limit } of this.windows) {
            const inWindow = live.filter((e) => e.at > now - windowMs);
            let remaining = inWindow.reduce((sum, e) => sum + e.weight, 0);
            if (remaining < limit) continue;

            // Walk from the oldest entry, dropping each as it would expire, until the window
            // falls below its limit — that entry's expiry is when this window frees up.
            for (const entry of inWindow) {
                remaining -= entry.weight;
                if (remaining < limit) {
                    retryAfterMs = Math.max(retryAfterMs, entry.at + windowMs - now);
                    break;
                }
            }
        }

        return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
    }

    /** Charges `weight` units to `key` at time `now`. Ignored when disabled or for non-positive weights. */
    record(key: string, weight: number, now: number): void {
        if (this.isDisabled || weight <= 0) return;
        const list = this.entries.get(key);
        if (list) list.push({ at: now, weight });
        else this.entries.set(key, [{ at: now, weight }]);
    }

    /** Evicts every key whose entries have all slid out of the longest window. Memory hygiene only. */
    sweep(now: number): void {
        const cutoff = now - this.maxWindowMs;
        for (const [key, list] of this.entries) {
            if (list.every((e) => e.at <= cutoff)) this.entries.delete(key);
        }
    }

    /** Drops `key`'s entries older than the longest window and returns the remaining ones. */
    private prune(key: string, now: number): LedgerEntry[] {
        const cutoff = now - this.maxWindowMs;
        const live = (this.entries.get(key) ?? []).filter((e) => e.at > cutoff);
        if (live.length > 0) this.entries.set(key, live);
        else this.entries.delete(key);
        return live;
    }
}
