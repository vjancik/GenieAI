import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { RateLimiter } from "../../../src/infrastructure/discord/RateLimiter.ts";

describe("RateLimiter", () => {
    beforeEach(() => {
        jest.setSystemTime(0);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("allows calls within a single window limit", () => {
        const limiter = new RateLimiter([{ windowMs: 3_000, limit: 3 }]);
        expect(limiter.check("u1")).toEqual({ allowed: true });
        expect(limiter.check("u1")).toEqual({ allowed: true });
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("denies when single window is exhausted", () => {
        const limiter = new RateLimiter([{ windowMs: 3_000, limit: 3 }]);
        limiter.check("u1");
        limiter.check("u1");
        limiter.check("u1");
        const result = limiter.check("u1");
        expect(result.allowed).toBe(false);
    });

    it("retryAfterMs is the time until the oldest blocking timestamp expires", () => {
        const limiter = new RateLimiter([{ windowMs: 3_000, limit: 3 }]);
        // All 3 calls at t=0
        limiter.check("u1");
        limiter.check("u1");
        limiter.check("u1");
        // Deny check at t=1000 — oldest timestamp is 0, expires at 0+3000=3000, so retryAfter = 2000
        jest.setSystemTime(1_000);
        const result = limiter.check("u1");
        expect(result).toEqual({ allowed: false, retryAfterMs: 2_000 });
    });

    it("retryAfterMs is the maximum across all violated windows", () => {
        const limiter = new RateLimiter([
            { windowMs: 3_000, limit: 1 },
            { windowMs: 10_000, limit: 1 },
        ]);
        limiter.check("u1"); // t=0
        jest.setSystemTime(1_000);
        const result = limiter.check("u1");
        // Short window: oldest=0, expires 0+3000=3000, retryAfter=2000
        // Long  window: oldest=0, expires 0+10000=10000, retryAfter=9000
        // Should report the larger: 9000
        expect(result).toEqual({ allowed: false, retryAfterMs: 9_000 });
    });

    it("does not record a timestamp on denied calls", () => {
        const limiter = new RateLimiter([{ windowMs: 3_000, limit: 3 }]);
        limiter.check("u1");
        limiter.check("u1");
        limiter.check("u1");
        // Denied — should not extend the window
        limiter.check("u1");
        // Advance past the window — all 3 original timestamps should have expired
        jest.setSystemTime(3_001);
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("resets after the window slides past old timestamps", () => {
        const limiter = new RateLimiter([{ windowMs: 3_000, limit: 3 }]);
        limiter.check("u1");
        limiter.check("u1");
        limiter.check("u1");
        jest.setSystemTime(3_001);
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("enforces multiple windows simultaneously", () => {
        const limiter = new RateLimiter([
            { windowMs: 3_000, limit: 3 },
            { windowMs: 60_000, limit: 10 },
        ]);
        // Fill the per-minute window
        for (let i = 0; i < 10; i++) {
            jest.setSystemTime(i * 4_000); // each call 4 s apart — past the 3 s window
            expect(limiter.check("u1")).toEqual({ allowed: true });
        }
        jest.setSystemTime(10 * 4_000);
        // 3 s window is clear but per-minute window is full
        expect(limiter.check("u1").allowed).toBe(false);
    });

    it("denies when short window is exhausted even if long window has capacity", () => {
        const limiter = new RateLimiter([
            { windowMs: 3_000, limit: 3 },
            { windowMs: 60_000, limit: 10 },
        ]);
        limiter.check("u1");
        limiter.check("u1");
        limiter.check("u1");
        expect(limiter.check("u1").allowed).toBe(false);
    });

    it("tracks different keys independently", () => {
        const limiter = new RateLimiter([{ windowMs: 3_000, limit: 1 }]);
        expect(limiter.check("u1")).toEqual({ allowed: true });
        expect(limiter.check("u2")).toEqual({ allowed: true });
        expect(limiter.check("u1").allowed).toBe(false);
        expect(limiter.check("u2").allowed).toBe(false);
    });
});
