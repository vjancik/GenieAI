import { describe, expect, test } from "bun:test";
import { load } from "@langchain/core/load";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { pruneToolCalls } from "../../../src/infrastructure/llm/agents/pruneToolCalls.ts";

const thoughtBlock = { type: "text", text: "thinking", thought: true, thoughtSignature: "sig-thought" };

function functionCallBlock(name: string, query: string, thoughtSignature?: string) {
    return {
        type: "functionCall",
        functionCall: { name, args: { query } },
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    };
}

function toolCall(name: string, query: string, id: string) {
    return { name, args: { query }, id, type: "tool_call" as const };
}

/** A Gemini-style response with two parallel calls, of which only the first carries a signature. */
function makeTwoCallMessage() {
    return new AIMessage({
        id: "message-id",
        content: [
            thoughtBlock,
            functionCallBlock("first_tool", "a", "sig-call"),
            functionCallBlock("second_tool", "b"),
        ],
        tool_calls: [toolCall("first_tool", "a", "lc-tool-call-1"), toolCall("second_tool", "b", "lc-tool-call-2")],
        additional_kwargs: { finishReason: "STOP" },
        response_metadata: { model_provider: "google" },
    });
}

function retainedCall(message: AIMessage, name: string) {
    const call = message.tool_calls?.find((tc) => tc.name === name);
    if (!call) throw new Error(`Missing tool call ${name}`);
    return call;
}

/** Retains the given calls unchanged. */
function unchanged(calls: ToolCall[]) {
    return new Map(calls.map((call) => [call, call]));
}

describe("pruneToolCalls", () => {
    test("removes a dropped call from both tool_calls and content, keeping its position's block", () => {
        const message = makeTwoCallMessage();

        const pruned = pruneToolCalls(message, unchanged([retainedCall(message, "second_tool")]));

        expect(pruned.tool_calls?.map((tc) => tc.name)).toEqual(["second_tool"]);
        expect(pruned.content).toEqual([thoughtBlock, functionCallBlock("second_tool", "b")]);
    });

    test("keeps the block holding the thought signature when its call is retained", () => {
        const message = makeTwoCallMessage();

        const pruned = pruneToolCalls(message, unchanged([retainedCall(message, "first_tool")]));

        expect(pruned.content).toEqual([thoughtBlock, functionCallBlock("first_tool", "a", "sig-call")]);
    });

    test("matches blocks by position when calls share a name", () => {
        const message = new AIMessage({
            content: [functionCallBlock("web_search", "a"), functionCallBlock("web_search", "b")],
            tool_calls: [toolCall("web_search", "a", "lc-tool-call-1"), toolCall("web_search", "b", "lc-tool-call-2")],
        });
        const secondCall = message.tool_calls?.[1];
        if (!secondCall) throw new Error("Missing tool call");

        const pruned = pruneToolCalls(message, unchanged([secondCall]));

        expect(pruned.content).toEqual([functionCallBlock("web_search", "b")]);
    });

    test("keeps every block when all calls are retained", () => {
        const message = makeTwoCallMessage();

        const pruned = pruneToolCalls(message, unchanged(message.tool_calls ?? []));

        expect(pruned.content).toEqual(message.content);
        expect(pruned.tool_calls).toHaveLength(2);
    });

    test("writes a rewritten call's arguments to both tool_calls and its content block", () => {
        const message = makeTwoCallMessage();
        const first = retainedCall(message, "first_tool");
        const rewritten = { ...first, args: { query: "narrowed" } };

        const pruned = pruneToolCalls(message, new Map([[first, rewritten]]));

        expect(pruned.tool_calls).toEqual([rewritten]);
        // The block keeps its other fields, such as the thought signature
        expect(pruned.content).toEqual([thoughtBlock, functionCallBlock("first_tool", "narrowed", "sig-call")]);
        // The original call and block are left as they were
        expect(first.args).toEqual({ query: "a" });
        expect(message.content).toEqual(makeTwoCallMessage().content);
    });

    test("leaves string content untouched", () => {
        const message = new AIMessage({
            content: "plain text",
            tool_calls: [toolCall("first_tool", "a", "1"), toolCall("second_tool", "b", "2")],
        });

        const pruned = pruneToolCalls(message, unchanged([retainedCall(message, "first_tool")]));

        expect(pruned.content).toBe("plain text");
        expect(pruned.tool_calls?.map((tc) => tc.name)).toEqual(["first_tool"]);
    });

    test("preserves other message fields and does not mutate the original", () => {
        const message = makeTwoCallMessage();

        const pruned = pruneToolCalls(message, unchanged([retainedCall(message, "first_tool")]));

        expect(pruned).toBeInstanceOf(AIMessage);
        expect(pruned.id).toBe("message-id");
        expect(pruned.additional_kwargs).toEqual({ finishReason: "STOP" });
        expect(pruned.response_metadata).toMatchObject({ model_provider: "google" });
        expect(message.tool_calls).toHaveLength(2);
        expect(message.content).toHaveLength(3);
    });

    test("stays pruned through the serialization used for persistence", async () => {
        const message = makeTwoCallMessage();

        const pruned = pruneToolCalls(message, unchanged([retainedCall(message, "first_tool")]));
        const restored = await load<BaseMessage>(JSON.stringify(pruned.toJSON()));

        expect(restored).toBeInstanceOf(AIMessage);
        expect((restored as AIMessage).tool_calls?.map((tc) => tc.name)).toEqual(["first_tool"]);
        expect(restored.content).toEqual([thoughtBlock, functionCallBlock("first_tool", "a", "sig-call")]);
    });
});
