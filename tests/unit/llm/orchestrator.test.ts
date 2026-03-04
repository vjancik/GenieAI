import { describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import {
    dbMessagesToLangchain,
    Orchestrator,
} from "../../../src/infrastructure/llm/orchestrator.ts";

const testLogger = pino({ level: "silent" });

/** Helper to create a mock model that returns a given response */
function makeModel(response: string) {
    return {
        invoke: mock(
            async (_messages: BaseMessage[]) => new AIMessage(response),
        ),
    };
}

/** Helper to create a mock tool that returns a given result */
function makeTool(result: string) {
    return {
        invoke: mock(async (_args: unknown) => result),
    };
}

/** Helper to create a triage model mock that returns a specific tool call */
function makeTriageWithToolCall(
    toolName: string,
    toolArgs: Record<string, unknown> = {},
) {
    return {
        invoke: mock(async (_messages: BaseMessage[]) => ({
            content: "",
            tool_calls: [
                {
                    name: toolName,
                    args: toolArgs,
                    id: "call_test_123",
                },
            ],
        })),
    };
}

/** Helper to create a triage model mock with no tool call */
function makeTriageWithNoToolCall() {
    return {
        invoke: mock(async (_messages: BaseMessage[]) => ({
            content: "I am confused",
            tool_calls: [],
        })),
    };
}

describe("dbMessagesToLangchain", () => {
    const baseMsg: Omit<DiscordMessage, "role" | "contentChunks"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        createdAt: new Date(),
    };

    test("converts human messages to HumanMessage", () => {
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                role: "human",
                contentChunks: [{ type: "text", text: "Hello!" }],
            },
        ];
        const result = dbMessagesToLangchain(records);
        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[0]?.content).toBe("Hello!");
    });

    test("converts assistant messages to AIMessage", () => {
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                role: "assistant",
                contentChunks: [{ type: "text", text: "Hi there!" }],
            },
        ];
        const result = dbMessagesToLangchain(records);
        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(AIMessage);
        expect(result[0]?.content).toBe("Hi there!");
    });

    test("preserves chronological order of multiple messages", () => {
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                discordMessageId: "d1",
                role: "human",
                contentChunks: [{ type: "text", text: "msg1" }],
            },
            {
                ...baseMsg,
                discordMessageId: "d2",
                role: "assistant",
                contentChunks: [{ type: "text", text: "msg2" }],
            },
            {
                ...baseMsg,
                discordMessageId: "d3",
                role: "human",
                contentChunks: [{ type: "text", text: "msg3" }],
            },
        ];
        const result = dbMessagesToLangchain(records);
        expect(result).toHaveLength(3);
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[1]).toBeInstanceOf(AIMessage);
        expect(result[2]).toBeInstanceOf(HumanMessage);
    });

    test("returns empty array for empty input", () => {
        expect(dbMessagesToLangchain([])).toEqual([]);
    });
});

describe("Orchestrator.process", () => {
    test("routes to search model when triage selects route_to_search", async () => {
        const triageModel = makeTriageWithToolCall("route_to_search");
        const generalModel = makeModel("general response");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool("video transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const result = await orchestrator.process([], "What happened today?");

        expect(searchModel.invoke).toHaveBeenCalledTimes(1);
        expect(generalModel.invoke).not.toHaveBeenCalled();
        expect(result).toBe("search response");
    });

    test("routes to general model when triage selects route_to_general", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const generalModel = makeModel("general response");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool("video transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const result = await orchestrator.process([], "Tell me a joke");

        expect(generalModel.invoke).toHaveBeenCalledTimes(1);
        expect(searchModel.invoke).not.toHaveBeenCalled();
        expect(result).toBe("general response");
    });

    test("calls get_website tool and passes result to general model", async () => {
        const triageModel = makeTriageWithToolCall("get_website", {
            urls: ["https://example.com"],
        });
        const generalModel = makeModel("summary of website");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool(
            "## https://example.com\n\nPage content here",
        );
        const videoTool = makeTool("video transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const result = await orchestrator.process(
            [],
            "Summarize https://example.com",
        );

        expect(websiteTool.invoke).toHaveBeenCalledWith({
            urls: ["https://example.com"],
        });
        // General model is called (with tool result context)
        expect(generalModel.invoke).toHaveBeenCalledTimes(1);
        expect(searchModel.invoke).not.toHaveBeenCalled();
        expect(result).toBe("summary of website");
    });

    test("calls get_video_transcription tool and passes result to general model", async () => {
        const triageModel = makeTriageWithToolCall("get_video_transcription", {
            urls: ["https://youtube.com/watch?v=abc"],
        });
        const generalModel = makeModel("video summary");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool(
            "## https://youtube.com/watch?v=abc\n\nTranscript here",
        );

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const result = await orchestrator.process([], "Summarize this video");

        expect(videoTool.invoke).toHaveBeenCalledWith({
            urls: ["https://youtube.com/watch?v=abc"],
        });
        expect(generalModel.invoke).toHaveBeenCalledTimes(1);
        expect(result).toBe("video summary");
    });

    test("falls back to general model when triage returns no tool call", async () => {
        const triageModel = makeTriageWithNoToolCall();
        const generalModel = makeModel("fallback response");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool("video transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const result = await orchestrator.process([], "Hello");

        expect(generalModel.invoke).toHaveBeenCalledTimes(1);
        expect(result).toBe("fallback response");
    });

    test("passes conversation history to the invoked model", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const generalModel = makeModel("response with context");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool("video transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const history: BaseMessage[] = [
            new HumanMessage("First message"),
            new AIMessage("First response"),
        ];

        await orchestrator.process(history, "Follow-up question");

        const callArgs = (generalModel.invoke as ReturnType<typeof mock>).mock
            .calls[0]?.[0] as BaseMessage[];
        expect(callArgs).toBeDefined();
        // Should include history messages in the invocation
        const contents = callArgs.map((m) => m.content);
        expect(contents).toContain("First message");
        expect(contents).toContain("First response");
        expect(contents).toContain("Follow-up question");
    });
});
