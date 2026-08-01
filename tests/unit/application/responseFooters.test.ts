import { describe, expect, it } from "bun:test";
import {
    FALLBACK_FOOTER,
    finishReasonFooter,
    INTERRUPTED_FOOTER,
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

    it("no footer uses dashes", () => {
        for (const footer of allFooters) {
            expect(footer).not.toMatch(/[-–—]/);
        }
    });
});
