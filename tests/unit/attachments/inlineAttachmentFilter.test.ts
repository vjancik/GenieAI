import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
    filterHistoryForInlineSize,
    getInlineAttachmentBytes,
} from "../../../src/infrastructure/llm/inlineAttachmentFilter.ts";

/** Builds a HumanMessage with one text block and the given attachment blocks. */
function humanWithAttachments(
    text: string,
    attachments: Array<{ type: string; data: string; mimeType: string }>,
): HumanMessage {
    const blocks: ContentBlock[] = [
        { type: "text" as const, text } as ContentBlock,
        ...attachments.map(
            (a) =>
                ({
                    type: a.type,
                    data: a.data,
                    mimeType: a.mimeType,
                }) as ContentBlock,
        ),
    ];
    return new HumanMessage(blocks);
}

const SHORT_DATA = "abc"; // 3 bytes
const LONG_DATA = "x".repeat(1000); // 1000 bytes

describe("getInlineAttachmentBytes", () => {
    test("returns 0 for empty array", () => {
        expect(getInlineAttachmentBytes([])).toBe(0);
    });

    test("returns 0 for string-content messages", () => {
        const msgs = [new HumanMessage("hello"), new AIMessage("world")];
        expect(getInlineAttachmentBytes(msgs)).toBe(0);
    });

    test("returns 0 for non-HumanMessages with structured content", () => {
        const ai = new AIMessage([{ type: "text", text: "hi" }]);
        expect(getInlineAttachmentBytes([ai])).toBe(0);
    });

    test("sums data field lengths of attachment blocks in HumanMessages", () => {
        const msg = humanWithAttachments("hi", [
            { type: "image", data: SHORT_DATA, mimeType: "image/jpeg" },
            { type: "image", data: SHORT_DATA, mimeType: "image/png" },
        ]);
        // 3 + 3 = 6
        expect(getInlineAttachmentBytes([msg])).toBe(6);
    });

    test("ignores text blocks", () => {
        const msg = humanWithAttachments("some text here", []);
        expect(getInlineAttachmentBytes([msg])).toBe(0);
    });

    test("accumulates across multiple messages", () => {
        const msg1 = humanWithAttachments("a", [{ type: "image", data: SHORT_DATA, mimeType: "image/jpeg" }]);
        const msg2 = humanWithAttachments("b", [{ type: "video", data: LONG_DATA, mimeType: "video/mp4" }]);
        expect(getInlineAttachmentBytes([msg1, msg2])).toBe(3 + 1000);
    });
});

describe("filterHistoryForInlineSize", () => {
    test("returns messages unchanged when already within budget", () => {
        const msg = humanWithAttachments("hi", [{ type: "image", data: SHORT_DATA, mimeType: "image/jpeg" }]);
        const result = filterHistoryForInlineSize([msg], 1000);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(msg); // same reference — no copy made
    });

    test("strips oldest attachment block first", () => {
        const msg1 = humanWithAttachments("first", [{ type: "image", data: LONG_DATA, mimeType: "image/jpeg" }]);
        const msg2 = humanWithAttachments("second", [{ type: "image", data: SHORT_DATA, mimeType: "image/png" }]);
        // total = 1000 + 3 = 1003; limit = 10 → strip LONG_DATA first
        const result = filterHistoryForInlineSize([msg1, msg2], 10);

        // msg1's image should be stripped; only the text block remains
        const filtered1 = result[0] as HumanMessage;
        const content1 = filtered1.content as ContentBlock[];
        expect(content1.every((b) => !("data" in b))).toBe(true);

        // msg2 is unchanged (SHORT_DATA = 3 ≤ 10 so stop after stripping long)
        expect(result[1]).toBe(msg2);
    });

    test("strips blocks one at a time within a message", () => {
        const msg = humanWithAttachments("hi", [
            { type: "image", data: "aa", mimeType: "image/jpeg" }, // 2 bytes
            { type: "image", data: "bbb", mimeType: "image/png" }, // 3 bytes
        ]);
        // total = 5; limit = 4 → strip first block (2 bytes) → remaining = 3 ≤ 4
        const result = filterHistoryForInlineSize([msg], 4);

        const filtered = result[0] as HumanMessage;
        const content = filtered.content as ContentBlock[];
        // text block + second image block should remain
        const dataBlocks = content.filter((b) => "data" in b);
        expect(dataBlocks).toHaveLength(1);
        expect((dataBlocks[0] as unknown as { data: string }).data).toBe("bbb");
    });

    test("preserves text blocks when stripping attachments", () => {
        const msg = humanWithAttachments("keep me", [{ type: "image", data: LONG_DATA, mimeType: "image/jpeg" }]);
        const result = filterHistoryForInlineSize([msg], 0);

        const filtered = result[0] as HumanMessage;
        const content = filtered.content as ContentBlock[];
        const textBlocks = content.filter((b) => b.type === "text");
        expect(textBlocks).toHaveLength(1);
        expect((textBlocks[0] as { type: "text"; text: string }).text).toBe("keep me");
    });

    test("does not mutate the original messages array", () => {
        const msg = humanWithAttachments("hi", [{ type: "image", data: LONG_DATA, mimeType: "image/jpeg" }]);
        const original = [msg];
        filterHistoryForInlineSize(original, 0);

        // Original array and message should be untouched
        expect(original).toHaveLength(1);
        const origContent = original[0]?.content as ContentBlock[];
        expect(origContent.some((b) => "data" in b)).toBe(true);
    });

    test("handles all attachments stripped across multiple messages", () => {
        const msg1 = humanWithAttachments("a", [{ type: "image", data: LONG_DATA, mimeType: "image/jpeg" }]);
        const msg2 = humanWithAttachments("b", [{ type: "image", data: LONG_DATA, mimeType: "image/png" }]);
        // limit = 0 → strip everything
        const result = filterHistoryForInlineSize([msg1, msg2], 0);

        for (const msg of result) {
            const content = (msg as HumanMessage).content as ContentBlock[];
            expect(content.every((b) => !("data" in b))).toBe(true);
        }
    });

    test("passes through non-HumanMessage messages unchanged", () => {
        const ai = new AIMessage("response");
        const result = filterHistoryForInlineSize([ai], 0);
        expect(result[0]).toBe(ai);
    });
});
