import { describe, expect, it } from "bun:test";
import {
    FinishReason,
    isDegradedFinishReason,
    parseFinishReason,
} from "../../../src/domain/value-objects/FinishReason.ts";

describe("parseFinishReason", () => {
    it("returns null when no reason was reported", () => {
        expect(parseFinishReason(undefined)).toBeNull();
        expect(parseFinishReason(null)).toBeNull();
        expect(parseFinishReason("")).toBeNull();
    });

    it("returns null for non-string values", () => {
        expect(parseFinishReason(42)).toBeNull();
        expect(parseFinishReason({ finishReason: "STOP" })).toBeNull();
    });

    it("passes through every known reason", () => {
        for (const reason of Object.values(FinishReason)) {
            expect(parseFinishReason(reason)).toBe(reason);
        }
    });

    it("normalizes casing", () => {
        expect(parseFinishReason("stop")).toBe(FinishReason.STOP);
        expect(parseFinishReason("Safety")).toBe(FinishReason.SAFETY);
        expect(parseFinishReason("max_tokens")).toBe(FinishReason.MAX_TOKENS);
    });

    // A reason the API adds after this code was written must degrade into a generic
    // failure — reading it as success would silently suppress the footer and the Retry button.
    it("maps an unrecognized reason to OTHER rather than success", () => {
        expect(parseFinishReason("SOME_FUTURE_REASON")).toBe(FinishReason.OTHER);
        expect(isDegradedFinishReason(parseFinishReason("SOME_FUTURE_REASON"))).toBe(true);
    });
});

describe("isDegradedFinishReason", () => {
    it("is false for a clean stop and for an absent reason", () => {
        expect(isDegradedFinishReason(FinishReason.STOP)).toBe(false);
        expect(isDegradedFinishReason(null)).toBe(false);
    });

    it("is true for every reason other than STOP", () => {
        const degraded = Object.values(FinishReason).filter((r) => r !== FinishReason.STOP);
        for (const reason of degraded) {
            expect(isDegradedFinishReason(reason)).toBe(true);
        }
        // Guards against the list silently shrinking to nothing if the enum is refactored
        expect(degraded.length).toBe(Object.values(FinishReason).length - 1);
    });
});
