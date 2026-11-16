import { describe, expect, it } from "bun:test";
import { BlockReason, parseBlockReason } from "../../../src/domain/value-objects/BlockReason.ts";

describe("parseBlockReason", () => {
    it("passes through every known reason", () => {
        for (const reason of Object.values(BlockReason)) {
            expect(parseBlockReason(reason)).toBe(reason);
        }
    });

    it("normalizes casing", () => {
        expect(parseBlockReason("safety")).toBe(BlockReason.SAFETY);
        expect(parseBlockReason("Image_Safety")).toBe(BlockReason.IMAGE_SAFETY);
    });

    // The prompt was blocked regardless, so a missing or new reason degrades to a generic block
    it.each([
        ["an unrecognized reason", "SOMETHING_NEW"],
        ["an empty string", ""],
        ["undefined", undefined],
        ["a non-string value", 42],
    ])("maps %s to OTHER", (_label, raw) => {
        expect(parseBlockReason(raw)).toBe(BlockReason.OTHER);
    });
});
