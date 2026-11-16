import { describe, expect, it } from "bun:test";
import {
    AllFreeKeysExhaustedError,
    AppError,
    DiscordError,
    EMPTY_MODEL_RESPONSE_MESSAGE,
    EMPTY_MODEL_RESPONSE_RETRY_ADVICE,
    extractDisplayMessage,
    findDisplayableError,
    getDeclaredRetryable,
    ModelNoCandidatesError,
    ModelOverloadedError,
    ModelPromptBlockedError,
    ModelTimeoutError,
    PaidKeyExhaustedError,
} from "../../../src/domain/errors/AppError.ts";
import { BlockReason } from "../../../src/domain/value-objects/BlockReason.ts";

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

describe.each([
    ["ModelOverloadedError", ModelOverloadedError, "MODEL_OVERLOADED", "overloaded"],
    ["ModelTimeoutError", ModelTimeoutError, "MODEL_TIMEOUT", "allotted time"],
] as const)("%s", (_name, ErrorClass, code, displayFragment) => {
    it(`sets code to ${code}`, () => {
        expect(new ErrorClass().code).toBe(code);
    });

    it("carries a user-facing displayMessage", () => {
        expect(new ErrorClass().displayMessage).toContain(displayFragment);
    });

    it("sets cause when provided", () => {
        const cause = new Error("raw model error");
        expect(new ErrorClass(cause).cause).toBe(cause);
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

describe("ModelPromptBlockedError", () => {
    it("carries the block reason and declares itself not retryable", () => {
        const err = new ModelPromptBlockedError(BlockReason.BLOCKLIST);

        expect(err.code).toBe("MODEL_PROMPT_BLOCKED");
        expect(err.blockReason).toBe(BlockReason.BLOCKLIST);
        expect(getDeclaredRetryable(err)).toBe(false);
    });

    it("explains every block reason and warns that replies will be blocked too", () => {
        for (const reason of Object.values(BlockReason)) {
            const message = new ModelPromptBlockedError(reason).displayMessage;
            expect(message).toContain("blocked");
            expect(message).toContain("Replying to this message will be blocked too");
        }
    });
});

describe("ModelNoCandidatesError", () => {
    it("shows the empty response message with retry advice and leaves retryability to the default", () => {
        const err = new ModelNoCandidatesError();

        expect(err.code).toBe("MODEL_NO_CANDIDATES");
        expect(err.displayMessage).toBe(`${EMPTY_MODEL_RESPONSE_MESSAGE} ${EMPTY_MODEL_RESPONSE_RETRY_ADVICE}`);
        expect(getDeclaredRetryable(err)).toBeNull();
    });
});

describe("findDisplayableError", () => {
    it("returns the AppError carrying the display message from a nested cause", () => {
        const inner = new ModelPromptBlockedError(BlockReason.SAFETY);
        const outer = new Error("graph failed", { cause: inner });

        expect(findDisplayableError(outer)).toBe(inner);
    });

    it("returns null when no AppError in the chain has a display message", () => {
        expect(findDisplayableError(new DiscordError("no display message"))).toBeNull();
        expect(findDisplayableError("not an error")).toBeNull();
    });
});

describe("getDeclaredRetryable", () => {
    it("returns null for an AppError that declares nothing", () => {
        expect(getDeclaredRetryable(new AllFreeKeysExhaustedError())).toBeNull();
    });

    it("ignores a retryable property that is not a boolean", () => {
        const err = Object.assign(new AllFreeKeysExhaustedError(), { retryable: "no" });
        expect(getDeclaredRetryable(err)).toBeNull();
    });
});
