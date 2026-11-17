import { describe, expect, test } from "bun:test";
import { GeminiUploadHttpError } from "../../../src/domain/errors/AppError.ts";
import { isKeyRotationError } from "../../../src/infrastructure/llm/errors/isKeyRotationError.ts";

describe("isKeyRotationError", () => {
    test.each([401, 402, 403, 429])("detects %d on a RequestError-shaped error (statusCode)", (statusCode) => {
        expect(isKeyRotationError(Object.assign(new Error("rejected"), { statusCode }))).toBe(true);
    });

    test.each([401, 402, 403, 429])("detects %d on an ApiError-shaped error (status)", (status) => {
        expect(isKeyRotationError(Object.assign(new Error("rejected"), { status }))).toBe(true);
    });

    test.each([401, 402, 403, 429])("detects %d on a GeminiUploadHttpError", (status) => {
        expect(isKeyRotationError(new GeminiUploadHttpError("upload failed", status, "body"))).toBe(true);
    });

    test.each([400, 404, 408, 500, 503])("ignores status %d", (statusCode) => {
        expect(isKeyRotationError(Object.assign(new Error("other"), { statusCode }))).toBe(false);
    });

    test("ignores status codes and quota wording that only appear in the message", () => {
        expect(isKeyRotationError(new Error("HTTP 429 Too Many Requests"))).toBe(false);
        expect(isKeyRotationError(new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toBe(false);
        expect(isKeyRotationError(new Error("Request failed with status code 403"))).toBe(false);
        expect(isKeyRotationError("429 Too Many Requests")).toBe(false);
    });

    test("ignores a message mentioning 429 on an error with another status", () => {
        const err = Object.assign(new Error("The input token count (1429000) exceeds the maximum"), {
            statusCode: 400,
        });
        expect(isKeyRotationError(err)).toBe(false);
    });

    test("ignores a status code given as a string", () => {
        expect(isKeyRotationError({ statusCode: "429" })).toBe(false);
    });

    test("ignores non-object values", () => {
        expect(isKeyRotationError(null)).toBe(false);
        expect(isKeyRotationError(undefined)).toBe(false);
        expect(isKeyRotationError(429)).toBe(false);
    });
});
