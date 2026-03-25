import { describe, expect, it } from "bun:test";
import {
    AllFreeKeysExhaustedError,
    AppError,
    DiscordError,
    extractDisplayMessage,
    PaidKeyExhaustedError,
} from "../../../src/domain/errors/AppError.ts";

describe("DiscordError", () => {
    it("sets code to DISCORD_ERROR", () => {
        const err = new DiscordError("something broke");
        expect(err.code).toBe("DISCORD_ERROR");
    });

    it("sets message correctly", () => {
        const err = new DiscordError("event failed");
        expect(err.message).toBe("event failed");
    });

    it("sets cause when provided", () => {
        const cause = new Error("root");
        const err = new DiscordError("wrapper", cause);
        expect(err.cause).toBe(cause);
    });

    it("is an instance of AppError", () => {
        expect(new DiscordError("x")).toBeInstanceOf(AppError);
    });
});

describe("AllFreeKeysExhaustedError", () => {
    it("sets code to ALL_FREE_KEYS_EXHAUSTED", () => {
        expect(new AllFreeKeysExhaustedError().code).toBe("ALL_FREE_KEYS_EXHAUSTED");
    });

    it("carries a user-facing displayMessage", () => {
        const err = new AllFreeKeysExhaustedError();
        expect(err.displayMessage).toBeTruthy();
        expect(err.displayMessage).toContain("exhausted");
    });

    it("sets cause when provided", () => {
        const cause = new Error("429");
        const err = new AllFreeKeysExhaustedError(cause);
        expect(err.cause).toBe(cause);
    });
});

describe("PaidKeyExhaustedError", () => {
    it("sets code to PAID_KEY_EXHAUSTED", () => {
        expect(new PaidKeyExhaustedError().code).toBe("PAID_KEY_EXHAUSTED");
    });

    it("carries a user-facing displayMessage", () => {
        const err = new PaidKeyExhaustedError();
        expect(err.displayMessage).toBeTruthy();
        expect(err.displayMessage).toContain("quota");
    });

    it("sets cause when provided", () => {
        const cause = new Error("429");
        const err = new PaidKeyExhaustedError(cause);
        expect(err.cause).toBe(cause);
    });
});

describe("extractDisplayMessage", () => {
    it("returns displayMessage from a direct AllFreeKeysExhaustedError", () => {
        const err = new AllFreeKeysExhaustedError();
        expect(extractDisplayMessage(err)).toBe(err.displayMessage ?? null);
    });

    it("returns displayMessage from a nested cause", () => {
        const inner = new PaidKeyExhaustedError();
        const outer = new Error("wrapper");
        // TYPE COERCION: assigning cause to a plain Error for test purposes
        (outer as unknown as { cause: unknown }).cause = inner;
        expect(extractDisplayMessage(outer)).toBe(inner.displayMessage ?? null);
    });

    it("returns null when no AppError with displayMessage exists in the chain", () => {
        const err = new Error("plain error");
        expect(extractDisplayMessage(err)).toBeNull();
    });

    it("returns null for non-Error values", () => {
        expect(extractDisplayMessage("string")).toBeNull();
        expect(extractDisplayMessage(null)).toBeNull();
        expect(extractDisplayMessage(42)).toBeNull();
    });

    it("skips AppError instances without a displayMessage", () => {
        const err = new DiscordError("no display");
        expect(extractDisplayMessage(err)).toBeNull();
    });
});
