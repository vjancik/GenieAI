import { describe, expect, test } from "bun:test";
import { isTimeoutError } from "../../../src/infrastructure/llm/errors/isTimeoutError.ts";

describe("isTimeoutError", () => {
    describe("detects timeout/abort patterns", () => {
        test("detects DOMException with name 'TimeoutError'", () => {
            const err = new DOMException("The operation timed out", "TimeoutError");
            expect(isTimeoutError(err)).toBe(true);
        });

        test("detects DOMException with name 'AbortError'", () => {
            const err = new DOMException("The operation was aborted", "AbortError");
            expect(isTimeoutError(err)).toBe(true);
        });

        test("detects plain Error with name 'AbortError'", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            expect(isTimeoutError(err)).toBe(true);
        });

        test("detects plain Error with name 'TimeoutError'", () => {
            const err = new Error("Timed out");
            err.name = "TimeoutError";
            expect(isTimeoutError(err)).toBe(true);
        });

        test("detects 'timeout' keyword in error.message (case-insensitive)", () => {
            expect(isTimeoutError(new Error("Request timeout exceeded"))).toBe(true);
        });

        test("detects 'Timeout' in error.message (capital T)", () => {
            expect(isTimeoutError(new Error("Timeout after 15000ms"))).toBe(true);
        });

        test("detects AbortSignal.timeout() DOMException shape", async () => {
            // AbortSignal.timeout() fires a TimeoutError DOMException after the delay.
            // Wait for the signal to fire so signal.reason is populated.
            const signal = AbortSignal.timeout(1);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(isTimeoutError(signal.reason)).toBe(true);
        });
    });

    describe("returns false for non-timeout errors", () => {
        test("returns false for a generic Error", () => {
            expect(isTimeoutError(new Error("Something went wrong"))).toBe(false);
        });

        test("returns false for a 503 error object", () => {
            expect(isTimeoutError({ status: 503, message: "Service Unavailable" })).toBe(false);
        });

        test("returns false for null", () => {
            expect(isTimeoutError(null)).toBe(false);
        });

        test("returns false for undefined", () => {
            expect(isTimeoutError(undefined)).toBe(false);
        });

        test("returns false for a number", () => {
            expect(isTimeoutError(500)).toBe(false);
        });

        test("returns false for an empty object", () => {
            expect(isTimeoutError({})).toBe(false);
        });

        test("returns false for an unrelated string", () => {
            // strings are not objects — function only checks object shapes
            expect(isTimeoutError("timeout")).toBe(false);
        });
    });
});
