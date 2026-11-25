import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { TokenRateLimiter } from "../../../src/infrastructure/discord/TokenRateLimiter.ts";

describe("TokenRateLimiter", () => {
    beforeEach(() => {
        jest.setSystemTime(0);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("allows while recorded usage stays below the limit", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1_000 }]);
        limiter.record("u1", 999);
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("denies once recorded usage reaches the limit, even when a single request overshot it", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1_000 }]);
        expect(limiter.check("u1")).toEqual({ allowed: true });
        limiter.record("u1", 5_000);
        expect(limiter.check("u1").allowed).toBe(false);
    });

    it("check does not record anything by itself", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1 }]);
        for (let i = 0; i < 10; i++) expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("retryAfterMs waits until enough of the oldest usage expires to drop below the limit", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1_000 }]);
        limiter.record("u1", 400); // t=0
        jest.setSystemTime(10_000);
        limiter.record("u1", 400); // t=10s
        jest.setSystemTime(20_000);
        limiter.record("u1", 400); // t=20s — total 1200

        // Dropping only the t=0 entry leaves 800 < 1000, so the wait ends when it expires at t=60s
        expect(limiter.check("u1")).toEqual({ allowed: false, retryAfterMs: 40_000 });
    });

    it("retryAfterMs skips past entries too small to bring the total under the limit", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1_000 }]);
        limiter.record("u1", 100); // t=0
        jest.setSystemTime(10_000);
        limiter.record("u1", 1_500); // t=10s — total 1600

        // Dropping the t=0 entry leaves 1500, so the wait lasts until the t=10s entry expires at t=70s
        expect(limiter.check("u1")).toEqual({ allowed: false, retryAfterMs: 70_000 - 10_000 });
    });

    it("frees up once the window slides past the usage", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1_000 }]);
        limiter.record("u1", 2_000);
        jest.setSystemTime(60_001);
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("reports the longest wait across exhausted windows", () => {
        const limiter = new TokenRateLimiter([
            { windowMs: 60_000, limit: 1_000 },
            { windowMs: 3_600_000, limit: 1_500 },
        ]);
        limiter.record("u1", 1_000); // t=0
        jest.setSystemTime(61_000);
        limiter.record("u1", 600); // t=61s — short window holds 600, long window holds 1600

        expect(limiter.check("u1")).toEqual({ allowed: false, retryAfterMs: 3_600_000 - 61_000 });
    });

    it("tracks keys independently", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1_000 }]);
        limiter.record("u1", 1_000);
        expect(limiter.check("u1").allowed).toBe(false);
        expect(limiter.check("u2")).toEqual({ allowed: true });
    });

    it("ignores non-positive weights", () => {
        const limiter = new TokenRateLimiter([{ windowMs: 60_000, limit: 1 }]);
        limiter.record("u1", 0);
        limiter.record("u1", -5);
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });

    it("allows everything when no windows are configured", () => {
        const limiter = new TokenRateLimiter([]);
        limiter.record("u1", 1_000_000_000);
        expect(limiter.check("u1")).toEqual({ allowed: true });
    });
});
