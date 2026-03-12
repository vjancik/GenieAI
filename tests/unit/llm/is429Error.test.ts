import { describe, expect, test } from "bun:test";
import { is429Error } from "../../../src/infrastructure/llm/errors/is429Error.ts";

describe("is429Error", () => {
    describe("detects rate-limit patterns", () => {
        test("detects '429' in a plain string error", () => {
            expect(is429Error("HTTP 429 Too Many Requests")).toBe(true);
        });

        test("detects 'RESOURCE_EXHAUSTED' in a plain string error", () => {
            expect(is429Error("RESOURCE_EXHAUSTED: quota exceeded")).toBe(true);
        });

        test("detects 'quota exceeded' (with space) in a plain string error", () => {
            expect(is429Error("quota exceeded for project")).toBe(true);
        });

        test("detects 'quota-exceeded' (with hyphen) in a plain string error", () => {
            expect(is429Error("quota-exceeded")).toBe(true);
        });

        test("detects '429' in error.message", () => {
            expect(is429Error(new Error("Request failed with status 429"))).toBe(true);
        });

        test("detects 'RESOURCE_EXHAUSTED' in error.message (case-insensitive)", () => {
            expect(is429Error(new Error("resource_exhausted quota"))).toBe(true);
        });

        test("detects numeric 429 in error.status", () => {
            expect(is429Error({ status: 429, message: "Rate limited" })).toBe(true);
        });

        test("detects numeric 429 in error.statusCode", () => {
            expect(is429Error({ statusCode: 429 })).toBe(true);
        });

        // test("detects pattern via JSON serialization fallback", () => {
        //     // An object with no message/status but with rate-limit text in a nested field
        //     const err = { details: { reason: "RESOURCE_EXHAUSTED" } };
        //     expect(is429Error(err)).toBe(true);
        // });
    });

    describe("returns false for non-rate-limit errors", () => {
        test("returns false for a generic 500 error message", () => {
            expect(is429Error(new Error("Internal server error"))).toBe(false);
        });

        test("returns false for a 404 status", () => {
            expect(is429Error({ status: 404 })).toBe(false);
        });

        test("returns false for null", () => {
            expect(is429Error(null)).toBe(false);
        });

        test("returns false for undefined", () => {
            expect(is429Error(undefined)).toBe(false);
        });

        test("returns false for a number", () => {
            expect(is429Error(500)).toBe(false);
        });

        test("returns false for an empty object", () => {
            expect(is429Error({})).toBe(false);
        });

        test("returns false for an unrelated string", () => {
            expect(is429Error("Something went wrong")).toBe(false);
        });

        test("returns false for false boolean", () => {
            expect(is429Error(false)).toBe(false);
        });
    });
});
