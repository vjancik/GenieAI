import { describe, expect, it } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { lastAiUsageMetadata, weighTokenUsage } from "../../../src/application/helpers/tokenUsageWeight.ts";

const WEIGHTS = { cachedTokensWeight: 0.1, outputTokensWeight: 5 };

describe("weighTokenUsage", () => {
    it("discounts cached input and weights output", () => {
        const usage = {
            input_tokens: 15_981,
            output_tokens: 299,
            total_tokens: 16_280,
            input_token_details: { cache_read: 10_337 },
        };
        // 15981 - 10337 + 10337 * 0.1 + 299 * 5
        expect(weighTokenUsage(usage, WEIGHTS)).toBeCloseTo(5_644 + 1_033.7 + 1_495);
    });

    it("charges all input at full weight when nothing was cached", () => {
        const usage = { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 };
        expect(weighTokenUsage(usage, WEIGHTS)).toBe(1_050);
    });

    it("clamps cache_read to input_tokens", () => {
        const usage = {
            input_tokens: 100,
            output_tokens: 0,
            total_tokens: 100,
            input_token_details: { cache_read: 500 },
        };
        expect(weighTokenUsage(usage, WEIGHTS)).toBeCloseTo(10);
    });

    it("honors zero weights", () => {
        const usage = {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_token_details: { cache_read: 100 },
        };
        expect(weighTokenUsage(usage, { cachedTokensWeight: 0, outputTokensWeight: 0 })).toBe(0);
    });
});

describe("lastAiUsageMetadata", () => {
    const usage = (input: number) => ({ input_tokens: input, output_tokens: 1, total_tokens: input + 1 });

    it("returns the usage of the last AI message", () => {
        const messages = [
            new AIMessage({ content: "", usage_metadata: usage(10) }),
            new ToolMessage({ content: "result", tool_call_id: "t1" }),
            new AIMessage({ content: "answer", usage_metadata: usage(20) }),
        ];
        expect(lastAiUsageMetadata(messages)?.input_tokens).toBe(20);
    });

    it("skips trailing AI messages without usage", () => {
        const messages = [new AIMessage({ content: "", usage_metadata: usage(10) }), new AIMessage("no usage")];
        expect(lastAiUsageMetadata(messages)?.input_tokens).toBe(10);
    });

    it("returns null when no AI message carries usage", () => {
        expect(lastAiUsageMetadata([new HumanMessage("hi"), new AIMessage("no usage")])).toBeNull();
        expect(lastAiUsageMetadata([])).toBeNull();
    });
});
