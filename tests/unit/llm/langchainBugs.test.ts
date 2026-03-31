/**
 * Regression tests for upstream @langchain/core bugs, and verification that
 * concatMessageChunks() correctly works around them.
 */

import { describe, expect, test } from "bun:test";
import { AIMessageChunk } from "@langchain/core/messages";
import { concatMessageChunks } from "../../../src/infrastructure/llm/utils/langchainUtils.ts";

// ---------------------------------------------------------------------------
// Bug: AIMessageChunk.concat() drops non-standard content blocks (e.g. executableCode)
// when reducing a stream of chunks with mixed content block types.
// ---------------------------------------------------------------------------

describe("@langchain/core — AIMessageChunk stream reduction", () => {
    /**
     * Simulates a Gemini code-execution stream: two text chunks, one executableCode
     * chunk, then two more text chunks. Reducing via concat() should preserve all
     * three distinct content blocks in order: text, executableCode, text.
     */
    test("reducing chunks with a non-standard block preserves all 3 content blocks", () => {
        const chunks: AIMessageChunk[] = [
            new AIMessageChunk({ content: "Sure, " }),
            new AIMessageChunk({ content: "here you go." }),
            new AIMessageChunk({
                content: [
                    {
                        type: "executableCode",
                        executableCode: {
                            language: "PYTHON",
                            code: "code omitted",
                        },
                    },
                ],
            }),
            new AIMessageChunk({ content: "The result " }),
            new AIMessageChunk({ content: "is 42." }),
        ];

        const [first, ...rest] = chunks;
        if (!first) throw new Error("chunks array is empty");
        const collected = rest.reduce((acc, chunk) => acc.concat(chunk), first);

        // BUG (@langchain/core): concat() produces 4 blocks instead of 3 — the two
        // trailing text chunks after the executableCode block are not merged together.
        // Expected: [text("Sure, here you go."), executableCode, text("The result is 42.")]
        // Actual:   [text("Sure, here you go."), executableCode, text("The result "), text("is 42.")]
        expect(collected.content).toHaveLength(4);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Sure, here you go." });
        expect(collected.content[1]).toMatchObject({
            type: "executableCode",
            executableCode: { language: "PYTHON", code: "code omitted" },
        });
        expect(collected.content[2]).toMatchObject({ type: "text", text: "The result " });
        expect(collected.content[3]).toMatchObject({ type: "text", text: "is 42." });
    });

    test("reducing chunks with an inlineData block preserves all 3 content blocks", () => {
        const chunks: AIMessageChunk[] = [
            new AIMessageChunk({ content: "Sure, " }),
            new AIMessageChunk({ content: "here you go." }),
            new AIMessageChunk({
                content: [
                    {
                        type: "inlineData",
                        inlineData: {
                            mimeType: "image/png",
                            data: "iVBORw0KGgoAAAAN",
                        },
                    },
                ],
            }),
            new AIMessageChunk({ content: "The result " }),
            new AIMessageChunk({ content: "is 42." }),
        ];

        const [first, ...rest] = chunks;
        if (!first) throw new Error("chunks array is empty");
        const collected = rest.reduce((acc, chunk) => acc.concat(chunk), first);

        // BUG (@langchain/core): same as executableCode — trailing text chunks after
        // a non-standard block are not merged.
        // Expected: [text("Sure, here you go."), inlineData, text("The result is 42.")]
        // Actual:   [text("Sure, here you go."), inlineData, text("The result "), text("is 42.")]
        expect(collected.content).toHaveLength(4);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Sure, here you go." });
        expect(collected.content[1]).toMatchObject({
            type: "inlineData",
            inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAAN" },
        });
        expect(collected.content[2]).toMatchObject({ type: "text", text: "The result " });
        expect(collected.content[3]).toMatchObject({ type: "text", text: "is 42." });
    });
});

// ---------------------------------------------------------------------------
// concatMessageChunks() — fixed behavior
// ---------------------------------------------------------------------------

describe("concatMessageChunks — fixed stream reduction", () => {
    function reduce(chunks: AIMessageChunk[]): AIMessageChunk {
        const [first, ...rest] = chunks;
        if (!first) throw new Error("chunks array is empty");
        return rest.reduce(concatMessageChunks, first);
    }

    test("executableCode block: trailing text chunks are merged into a single block", () => {
        const collected = reduce([
            new AIMessageChunk({ content: "Sure, " }),
            new AIMessageChunk({ content: "here you go." }),
            new AIMessageChunk({
                content: [{ type: "executableCode", executableCode: { language: "PYTHON", code: "code omitted" } }],
            }),
            new AIMessageChunk({ content: "The result " }),
            new AIMessageChunk({ content: "is 42." }),
        ]);

        expect(collected.content).toHaveLength(3);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Sure, here you go." });
        expect(collected.content[1]).toMatchObject({
            type: "executableCode",
            executableCode: { language: "PYTHON", code: "code omitted" },
        });
        expect(collected.content[2]).toMatchObject({ type: "text", text: "The result is 42." });
    });

    test("inlineData block: trailing text chunks are merged into a single block", () => {
        const collected = reduce([
            new AIMessageChunk({ content: "Sure, " }),
            new AIMessageChunk({ content: "here you go." }),
            new AIMessageChunk({
                content: [{ type: "inlineData", inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAAN" } }],
            }),
            new AIMessageChunk({ content: "The result " }),
            new AIMessageChunk({ content: "is 42." }),
        ]);

        expect(collected.content).toHaveLength(3);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Sure, here you go." });
        expect(collected.content[1]).toMatchObject({
            type: "inlineData",
            inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAAN" },
        });
        expect(collected.content[2]).toMatchObject({ type: "text", text: "The result is 42." });
    });

    // 1. Two plain string chunks + a text block with thoughtSignature → one merged block
    test("two plain-string chunks followed by a signed text block merge into one block with signature", () => {
        const collected = reduce([
            new AIMessageChunk({ content: "Hello " }),
            new AIMessageChunk({ content: "world" }),
            new AIMessageChunk({
                content: [{ type: "text", text: "!", thoughtSignature: "sig-x" }],
            }),
        ]);

        expect(collected.content).toHaveLength(1);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Hello world!", thoughtSignature: "sig-x" });
    });

    // 2. Two text blocks both with their own thoughtSignature → kept as 2 separate blocks
    test("two text chunks with independent thoughtSignatures are kept separate", () => {
        const collected = reduce([
            new AIMessageChunk({
                content: [{ type: "text", text: "Thought A", thoughtSignature: "sig-a" }],
            }),
            new AIMessageChunk({
                content: [{ type: "text", text: "Thought B", thoughtSignature: "sig-b" }],
            }),
        ]);

        expect(collected.content).toHaveLength(2);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Thought A", thoughtSignature: "sig-a" });
        expect(collected.content[1]).toMatchObject({ type: "text", text: "Thought B", thoughtSignature: "sig-b" });
    });

    // 3. text string → non-text block → text block → remains 3 blocks (first normalized to text block)
    test("text string → non-text block → text block stays as 3 separate blocks", () => {
        const collected = reduce([
            new AIMessageChunk({ content: "Before" }),
            new AIMessageChunk({
                content: [{ type: "executableCode", executableCode: { language: "PYTHON", code: "print(1)" } }],
            }),
            new AIMessageChunk({
                content: [{ type: "text", text: "After" }],
            }),
        ]);

        expect(collected.content).toHaveLength(3);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Before" });
        expect(collected.content[1]).toMatchObject({
            type: "executableCode",
            executableCode: { language: "PYTHON", code: "print(1)" },
        });
        expect(collected.content[2]).toMatchObject({ type: "text", text: "After" });
    });

    test("text chunk with thoughtSignature merges into preceding plain text chunk, carrying the signature", () => {
        const collected = reduce([
            new AIMessageChunk({ content: "Thinking..." }),
            new AIMessageChunk({
                content: [{ type: "text", text: "", thoughtSignature: "sig-x" }],
            }),
        ]);

        expect(collected.content).toHaveLength(1);
        expect(collected.content[0]).toMatchObject({ type: "text", text: "Thinking...", thoughtSignature: "sig-x" });
    });
});
