import { describe, expect, test } from "bun:test";
import { TavilySearchError } from "../../../src/domain/errors/AppError.ts";
import { isTavilyKeyRotationError } from "../../../src/infrastructure/llm/errors/isTavilyKeyRotationError.ts";

describe("isTavilyKeyRotationError", () => {
    test.each([401, 403, 429, 432, 433])("is true for HTTP %d", (status) => {
        expect(isTavilyKeyRotationError(new TavilySearchError("failed", status, "{}"))).toBe(true);
    });

    test.each([400, 402, 404, 500, 503])("is false for HTTP %d", (status) => {
        expect(isTavilyKeyRotationError(new TavilySearchError("failed", status, "{}"))).toBe(false);
    });

    test("is false for an error without a status, even when the message contains one", () => {
        expect(isTavilyKeyRotationError(new TavilySearchError("Error 432: out of credits", null, null))).toBe(false);
        expect(isTavilyKeyRotationError(new Error("Error 432: out of credits"))).toBe(false);
    });
});
