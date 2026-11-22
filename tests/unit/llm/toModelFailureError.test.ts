import { describe, expect, test } from "bun:test";
import {
    extractDisplayMessage,
    getDeclaredRetryable,
    InputTokenBudgetExceededError,
    ModelNoCandidatesError,
    ModelOverloadedError,
    ModelPromptBlockedError,
    ModelTimeoutError,
} from "../../../src/domain/errors/AppError.ts";
import { BlockReason } from "../../../src/domain/value-objects/BlockReason.ts";
import { isModelFallbackError } from "../../../src/infrastructure/llm/errors/isModelFallbackError.ts";
import { toModelFailureError } from "../../../src/infrastructure/llm/errors/toModelFailureError.ts";

/** Mirrors the `@langchain/google` PromptBlockedError, which embeds the safety ratings JSON in its message. */
function makePromptBlockedError(blockReason: unknown, safetyRatingsJson = "[]") {
    return Object.assign(new Error(`Prompt was blocked: ${blockReason}. Safety ratings: ${safetyRatingsJson}`), {
        name: "PromptBlockedError",
        blockReason,
        safetyRatings: [],
    });
}

/** Mirrors the `@langchain/google` NoCandidatesError. */
function makeNoCandidatesError() {
    return Object.assign(
        new Error("No candidates returned from API. This may indicate the prompt was blocked or an error occurred."),
        { name: "NoCandidatesError" },
    );
}

/** Mirrors the `@langchain/google` RequestError Gemini returns when the model is under high demand. */
function makeOverloadedRequestError() {
    return Object.assign(
        new Error("This model is currently experiencing high demand. Spikes in demand are usually temporary."),
        {
            name: "RequestError",
            statusCode: 503,
            statusText: "Service Unavailable",
            data: { error: { code: 503, status: "UNAVAILABLE" } },
        },
    );
}

describe("toModelFailureError", () => {
    test("maps a Gemini 503 RequestError to ModelOverloadedError with the raw error as cause", () => {
        const raw = makeOverloadedRequestError();

        const mapped = toModelFailureError(raw);

        expect(mapped).toBeInstanceOf(ModelOverloadedError);
        expect((mapped as ModelOverloadedError).cause).toBe(raw);
        expect(extractDisplayMessage(mapped)).toBe(
            "The AI provider servers are temporarily overloaded, you can try again later.",
        );
    });

    test.each([
        ["TimeoutError", new DOMException("The operation timed out.", "TimeoutError")],
        ["AbortError", new DOMException("The operation was aborted.", "AbortError")],
    ])("maps a %s to ModelTimeoutError with the raw error as cause", (_name, raw) => {
        const mapped = toModelFailureError(raw);

        expect(mapped).toBeInstanceOf(ModelTimeoutError);
        expect((mapped as ModelTimeoutError).cause).toBe(raw);
        expect(extractDisplayMessage(mapped)).toBe(
            "The AI model failed to respond within allotted time, you can try again later.",
        );
    });

    test.each([
        ["a 400 RequestError", Object.assign(new Error("Bad Request"), { statusCode: 400 })],
        ["a 503 mentioned only in the message", new Error("503 Service Unavailable")],
        ["a generic server error", new Error("Internal server error")],
        ["a non-error value", "boom"],
    ])("returns %s unchanged", (_label, raw) => {
        expect(toModelFailureError(raw)).toBe(raw);
    });
});

describe("toModelFailureError — provider rejections", () => {
    test("maps a blocked prompt to a non-retryable ModelPromptBlockedError carrying the parsed reason", () => {
        const raw = makePromptBlockedError("SAFETY");

        const mapped = toModelFailureError(raw);

        expect(mapped).toBeInstanceOf(ModelPromptBlockedError);
        const blocked = mapped as ModelPromptBlockedError;
        expect(blocked.cause).toBe(raw);
        expect(blocked.blockReason).toBe(BlockReason.SAFETY);
        expect(getDeclaredRetryable(blocked)).toBe(false);
        expect(blocked.displayMessage).toContain("safety filter");
    });

    test("maps an unrecognized block reason to OTHER", () => {
        const mapped = toModelFailureError(makePromptBlockedError("SOMETHING_NEW"));

        expect((mapped as ModelPromptBlockedError).blockReason).toBe(BlockReason.OTHER);
    });

    test("maps a blocked prompt whose message mentions 503 or a timeout by its shape", () => {
        const mapped = toModelFailureError(makePromptBlockedError("OTHER", '[{"note":"503 timeout"}]'));

        expect(mapped).toBeInstanceOf(ModelPromptBlockedError);
    });

    test("maps a response without candidates to ModelNoCandidatesError with the raw error as cause", () => {
        const raw = makeNoCandidatesError();

        const mapped = toModelFailureError(raw);

        expect(mapped).toBeInstanceOf(ModelNoCandidatesError);
        expect((mapped as ModelNoCandidatesError).cause).toBe(raw);
        expect(extractDisplayMessage(mapped)).toBe(
            "The AI model returned an empty response. A retry usually fixes this unless the provider servers are temporarily overloaded.",
        );
    });

    test("leaves an unrelated error named like a provider rejection but missing its fields unchanged", () => {
        const raw = Object.assign(new Error("blocked"), { name: "PromptBlockedError" });

        expect(toModelFailureError(raw)).toBe(raw);
    });
});

describe("isModelFallbackError", () => {
    test.each([
        ["a blocked prompt", makePromptBlockedError("SAFETY")],
        ["a response without candidates", makeNoCandidatesError()],
        ["a 503", Object.assign(new Error("high demand"), { statusCode: 503 })],
        ["a timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ])("is true for %s", (_label, err) => {
        expect(isModelFallbackError(err)).toBe(true);
    });

    test("is false for a 400", () => {
        expect(isModelFallbackError(Object.assign(new Error("Bad Request"), { statusCode: 400 }))).toBe(false);
    });

    test("is false for an exceeded input token budget, even when its message contains 503", () => {
        const err = new InputTokenBudgetExceededError(150_300, 100_000);
        expect(err.message).toContain("503");
        expect(isModelFallbackError(err)).toBe(false);
    });
});
