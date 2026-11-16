import { describe, expect, it } from "bun:test";
import {
    emptyResponseNotice,
    FALLBACK_FOOTER,
    finishReasonFooter,
    INTERRUPTED_FOOTER,
    responseFooter,
} from "../../../src/application/formatters/responseFooters.ts";
import { FinishReason } from "../../../src/domain/value-objects/FinishReason.ts";

const DEGRADED_REASONS = Object.values(FinishReason).filter((r) => r !== FinishReason.STOP);

describe("finishReasonFooter", () => {
    it("returns nothing for a clean stop or an absent reason", () => {
        expect(finishReasonFooter(FinishReason.STOP)).toBe("");
        expect(finishReasonFooter(null)).toBe("");
    });

    it("returns a footer for every degraded reason", () => {
        for (const reason of DEGRADED_REASONS) {
            expect(finishReasonFooter(reason)).not.toBe("");
        }
    });

    it("explains safety stops without leaking the API enum name", () => {
        const footer = finishReasonFooter(FinishReason.SAFETY);
        expect(footer).toContain("content filter");
        expect(footer).not.toContain("SAFETY");
    });

    it("distinguishes a length cutoff from a filtered one", () => {
        expect(finishReasonFooter(FinishReason.MAX_TOKENS)).not.toBe(finishReasonFooter(FinishReason.SAFETY));
        expect(finishReasonFooter(FinishReason.MAX_TOKENS)).toContain("too long");
    });

    it("groups the safety family onto one message", () => {
        const safety = finishReasonFooter(FinishReason.SAFETY);
        for (const reason of [
            FinishReason.PROHIBITED_CONTENT,
            FinishReason.BLOCKLIST,
            FinishReason.SPII,
            FinishReason.IMAGE_SAFETY,
            FinishReason.IMAGE_PROHIBITED_CONTENT,
        ] as const) {
            expect(finishReasonFooter(reason)).toBe(safety);
        }
    });
});

const CLEAN = { finishReason: null, wasInterrupted: false, usedRetryableFallback: false };

describe("responseFooter", () => {
    it("returns nothing for a clean response", () => {
        expect(responseFooter(CLEAN)).toBe("");
        expect(responseFooter({ ...CLEAN, finishReason: FinishReason.STOP })).toBe("");
    });

    it("explains a degraded finish reason", () => {
        expect(responseFooter({ ...CLEAN, finishReason: FinishReason.SAFETY })).toBe(
            finishReasonFooter(FinishReason.SAFETY),
        );
    });

    it("falls back to the interruption notice when no reason was reported", () => {
        expect(responseFooter({ ...CLEAN, wasInterrupted: true })).toBe(INTERRUPTED_FOOTER);
    });

    it("prefers the specific finish reason over the interruption notice", () => {
        expect(responseFooter({ ...CLEAN, wasInterrupted: true, finishReason: FinishReason.SAFETY })).toBe(
            finishReasonFooter(FinishReason.SAFETY),
        );
    });

    it("puts the fallback notice ahead of a generation footer", () => {
        expect(responseFooter({ ...CLEAN, usedRetryableFallback: true, finishReason: FinishReason.MAX_TOKENS })).toBe(
            FALLBACK_FOOTER + finishReasonFooter(FinishReason.MAX_TOKENS),
        );
    });
});

describe("emptyResponseNotice", () => {
    it("carries its own retry advice when no footer will follow", () => {
        const notice = emptyResponseNotice(CLEAN);
        expect(notice).toStartWith("The AI model returned an empty response.");
        expect(notice).toContain("A retry usually fixes this");
    });

    it.each([
        ["a degraded finish reason", { ...CLEAN, finishReason: FinishReason.SAFETY }],
        ["an interruption", { ...CLEAN, wasInterrupted: true }],
        ["a retryable fallback", { ...CLEAN, usedRetryableFallback: true }],
    ])("leaves the explanation and retry advice to the footer after %s", (_label, flags) => {
        expect(emptyResponseNotice(flags)).toBe("The AI model returned an empty response.");
    });
});

describe("footer copy conventions", () => {
    const allFooters = [FALLBACK_FOOTER, INTERRUPTED_FOOTER, ...DEGRADED_REASONS.map(finishReasonFooter)];

    it("every footer is a leading-newline italic single line", () => {
        for (const footer of allFooters) {
            expect(footer.startsWith("\n*")).toBe(true);
            expect(footer.endsWith("*")).toBe(true);
            expect(footer.slice(1).includes("\n")).toBe(false);
        }
    });

    it("every footer points the user at Retry", () => {
        for (const footer of allFooters) {
            expect(footer).toContain("Retry");
        }
    });

    // "Interrupted" is accurate for both the non-streaming and streaming paths; "cut short" is not
    it("no generation footer says the response was cut short", () => {
        for (const footer of DEGRADED_REASONS.map(finishReasonFooter)) {
            expect(footer).not.toContain("cut short");
        }
    });

    it("no footer uses dashes", () => {
        for (const footer of allFooters) {
            expect(footer).not.toMatch(/[-–—]/);
        }
    });
});
