import { describe, expect, test } from "bun:test";
import { is503Error } from "../../../src/infrastructure/llm/errors/is503Error.ts";

describe("is503Error", () => {
    describe("detects service-unavailable patterns", () => {
        test("detects '503' in a plain string error", () => {
            expect(is503Error("HTTP 503 Service Unavailable")).toBe(true);
        });

        test("detects 'Service Unavailable' in a plain string error", () => {
            expect(is503Error("Service Unavailable")).toBe(true);
        });

        test("detects 'server error' in a plain string error (case-insensitive)", () => {
            expect(is503Error("internal server error")).toBe(true);
        });

        test("detects '503' in error.message", () => {
            expect(is503Error(new Error("Request failed with status 503"))).toBe(true);
        });

        test("detects 'Service Unavailable' in error.message", () => {
            expect(is503Error(new Error("503 Service Unavailable"))).toBe(true);
        });

        test("detects numeric 503 in error.status", () => {
            expect(is503Error({ status: 503, message: "Service unavailable" })).toBe(true);
        });

        test("detects numeric 503 in error.statusCode", () => {
            expect(is503Error({ statusCode: 503 })).toBe(true);
        });
    });

    describe("returns false for non-503 errors", () => {
        test("returns false for a generic 500 error message", () => {
            expect(is503Error(new Error("Internal error"))).toBe(false);
        });

        test("returns false for a 429 status", () => {
            expect(is503Error({ status: 429 })).toBe(false);
        });

        test("returns false for a 404 status", () => {
            expect(is503Error({ status: 404 })).toBe(false);
        });

        test("returns false for null", () => {
            expect(is503Error(null)).toBe(false);
        });

        test("returns false for undefined", () => {
            expect(is503Error(undefined)).toBe(false);
        });

        test("returns false for a number", () => {
            expect(is503Error(500)).toBe(false);
        });

        test("returns false for an empty object", () => {
            expect(is503Error({})).toBe(false);
        });

        test("returns false for an unrelated string", () => {
            expect(is503Error("Something went wrong")).toBe(false);
        });
    });
});
