import { describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
    ChatMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import pino from "pino";
import type { AgentStatusUpdate } from "../../../src/application/types/AgentStatus.ts";
import { AgentStatusType } from "../../../src/application/types/AgentStatus.ts";
import { AppError } from "../../../src/domain/errors/AppError.ts";
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
        invoke: mock(
            async (_messages: BaseMessage[]) =>
                new AIMessage({
                    content: "",
                    tool_calls: [
                        {
                            name: toolName,
                            args: toolArgs,
                            id: "call_test_123",
                            type: "tool_call",
                        },
                    ],
                }),
        ),
    };
}

/** Helper to create a triage model mock with no tool call */
function makeTriageWithNoToolCall() {
    return {
        invoke: mock(
            async (_messages: BaseMessage[]) =>
                new AIMessage({ content: "I am confused", tool_calls: [] }),
        ),
    };
}

describe("dbMessagesToLangchain", () => {
    const baseMsg: Omit<DiscordMessage, "role" | "langchainMessages"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        createdAt: new Date(),
    };

    test("converts a serialized HumanMessage back to HumanMessage", () => {
        const original = new HumanMessage("Hello!");
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                role: "human",
                langchainMessages: [
                    original.toJSON() as unknown as Record<string, unknown>,
                ],
            },
        ];
        const result = dbMessagesToLangchain(records, testLogger);
        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[0]?.content).toBe("Hello!");
    });

    test("converts a serialized AIMessage back to AIMessage", () => {
        const original = new AIMessage("Hi there!");
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                role: "assistant",
                langchainMessages: [
                    original.toJSON() as unknown as Record<string, unknown>,
                ],
            },
        ];
        const result = dbMessagesToLangchain(records, testLogger);
        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(AIMessage);
        expect(result[0]?.content).toBe("Hi there!");
    });

    test("flattens multiple langchainMessages per record into a single array", () => {
        const ai1 = new AIMessage("triage response");
        const ai2 = new AIMessage("final response");
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                role: "assistant",
                langchainMessages: [
                    ai1.toJSON() as unknown as Record<string, unknown>,
                    ai2.toJSON() as unknown as Record<string, unknown>,
                ],
            },
        ];
        const result = dbMessagesToLangchain(records, testLogger);
        expect(result).toHaveLength(2);
        expect(result[0]).toBeInstanceOf(AIMessage);
        expect(result[0]?.content).toBe("triage response");
        expect(result[1]).toBeInstanceOf(AIMessage);
        expect(result[1]?.content).toBe("final response");
    });

    test("preserves chronological order across multiple records", () => {
        const human = new HumanMessage("msg1");
        const ai = new AIMessage("msg2");
        const humanFollow = new HumanMessage("msg3");
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                discordMessageId: "d1",
                role: "human",
                langchainMessages: [
                    human.toJSON() as unknown as Record<string, unknown>,
                ],
            },
            {
                ...baseMsg,
                discordMessageId: "d2",
                role: "assistant",
                langchainMessages: [
                    ai.toJSON() as unknown as Record<string, unknown>,
                ],
            },
            {
                ...baseMsg,
                discordMessageId: "d3",
                role: "human",
                langchainMessages: [
                    humanFollow.toJSON() as unknown as Record<string, unknown>,
                ],
            },
        ];
        const result = dbMessagesToLangchain(records, testLogger);
        expect(result).toHaveLength(3);
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[1]).toBeInstanceOf(AIMessage);
        expect(result[2]).toBeInstanceOf(HumanMessage);
    });

    test("returns empty array for empty input", () => {
        expect(dbMessagesToLangchain([], testLogger)).toEqual([]);
    });
});

describe("dbMessagesToLangchain — constructor dispatch", () => {
    const baseMsg: Omit<DiscordMessage, "role" | "langchainMessages"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        createdAt: new Date(),
    };

    function singleRecord(json: Record<string, unknown>): DiscordMessage[] {
        return [
            {
                ...baseMsg,
                role: "human",
                langchainMessages: [json],
            },
        ];
    }

    test("round-trips HumanMessage", () => {
        const original = new HumanMessage("hello");
        const result = dbMessagesToLangchain(
            singleRecord(
                original.toJSON() as unknown as Record<string, unknown>,
            ),
            testLogger,
        );
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[0]?.content).toBe("hello");
    });

    test("round-trips AIMessage", () => {
        const original = new AIMessage("hi");
        const result = dbMessagesToLangchain(
            singleRecord(
                original.toJSON() as unknown as Record<string, unknown>,
            ),
            testLogger,
        );
        expect(result[0]).toBeInstanceOf(AIMessage);
        expect(result[0]?.content).toBe("hi");
    });

    test("round-trips ToolMessage preserving tool_call_id", () => {
        const original = new ToolMessage({
            content: "tool result",
            tool_call_id: "call_abc",
        });
        const result = dbMessagesToLangchain(
            singleRecord(
                original.toJSON() as unknown as Record<string, unknown>,
            ),
            testLogger,
        );
        expect(result[0]).toBeInstanceOf(ToolMessage);
        expect((result[0] as ToolMessage).tool_call_id).toBe("call_abc");
        expect(result[0]?.content).toBe("tool result");
    });

    test("throws AppError for SystemMessage", () => {
        const original = new SystemMessage("system prompt");
        expect(() =>
            dbMessagesToLangchain(
                singleRecord(
                    original.toJSON() as unknown as Record<string, unknown>,
                ),
                testLogger,
            ),
        ).toThrow(AppError);
    });

    test("throws AppError for unknown message type", () => {
        const unknown: Record<string, unknown> = {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "WeirdMessage"],
            kwargs: { content: "hi" },
        };
        expect(() =>
            dbMessagesToLangchain(singleRecord(unknown), testLogger),
        ).toThrow(AppError);
    });

    test("round-trips ChatMessage and logs a warning", () => {
        const warnMock = mock(() => {});
        const mockLogger = {
            ...testLogger,
            warn: warnMock,
        } as typeof testLogger;

        const original = new ChatMessage({ content: "hi", role: "user" });
        const result = dbMessagesToLangchain(
            singleRecord(
                original.toJSON() as unknown as Record<string, unknown>,
            ),
            mockLogger,
        );
        expect(result[0]).toBeInstanceOf(ChatMessage);
        expect(warnMock).toHaveBeenCalledTimes(1);
    });
});

describe("dbMessagesToLangchain — thought chunk filtering", () => {
    const baseMsg: Omit<DiscordMessage, "role" | "langchainMessages"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        createdAt: new Date(),
    };

    /** Serialized AIMessage with a thought chunk and a visible text chunk */
    function thoughtRecord(): DiscordMessage[] {
        const msg = new AIMessage({
            content: [
                { type: "text", text: "internal reasoning", thought: true },
                { type: "text", text: "visible answer" },
            ],
        });
        return [
            {
                ...baseMsg,
                role: "assistant",
                langchainMessages: [
                    msg.toJSON() as unknown as Record<string, unknown>,
                ],
            },
        ];
    }

    test("strips thought chunks by default (filterThoughtChunks = true)", () => {
        const [result] = dbMessagesToLangchain(thoughtRecord(), testLogger);
        expect(Array.isArray(result?.content)).toBe(true);
        const parts = result?.content as {
            type: string;
            text: string;
            thought?: boolean;
        }[];
        expect(parts.some((p) => p.thought === true)).toBe(false);
        expect(parts).toHaveLength(1);
        expect(parts[0]?.text).toBe("visible answer");
    });

    test("preserves thought chunks when filterThoughtChunks = false", () => {
        const [result] = dbMessagesToLangchain(
            thoughtRecord(),
            testLogger,
            false,
        );
        const parts = result?.content as { type: string; thought?: boolean }[];
        expect(parts.some((p) => p.thought === true)).toBe(true);
        expect(parts).toHaveLength(2);
    });

    test("does not affect messages with string content", () => {
        const msg = new HumanMessage("plain text");
        const records: DiscordMessage[] = [
            {
                ...baseMsg,
                role: "human",
                langchainMessages: [
                    msg.toJSON() as unknown as Record<string, unknown>,
                ],
            },
        ];
        const [result] = dbMessagesToLangchain(records, testLogger);
        expect(result?.content).toBe("plain text");
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
        expect(result.content).toBe("search response");
        expect(result.newMessages).toHaveLength(1);
        expect(result.newMessages[0]).toBeInstanceOf(AIMessage);
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
        expect(result.content).toBe("general response");
        expect(result.newMessages).toHaveLength(1);
        expect(result.newMessages[0]).toBeInstanceOf(AIMessage);
    });

    test("calls get_website tool and passes result to general model, returning 3 messages", async () => {
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
        expect(generalModel.invoke).toHaveBeenCalledTimes(1);
        expect(searchModel.invoke).not.toHaveBeenCalled();
        expect(result.content).toBe("summary of website");
        // triage AIMessage + ToolMessage + final AIMessage
        expect(result.newMessages).toHaveLength(3);
    });

    test("calls get_video_transcription tool and passes result to general model, returning 3 messages", async () => {
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
        expect(result.content).toBe("video summary");
        // triage AIMessage + ToolMessage + final AIMessage
        expect(result.newMessages).toHaveLength(3);
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
        expect(result.content).toBe("fallback response");
        expect(result.newMessages).toHaveLength(1);
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

    test("filters out thought chunks from content but includes them in newMessages", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const thoughtResponse = new AIMessage({
            content: [
                { type: "text", text: "My reasoning here...", thought: true },
                { type: "text", text: "The actual answer." },
            ],
        });
        const generalModel = {
            invoke: mock(async (_messages: BaseMessage[]) => thoughtResponse),
        };
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

        const result = await orchestrator.process([], "Think about this");

        // Thought chunks excluded from displayed content
        expect(result.content).toBe("The actual answer.");
        // But the full message (including thought) is preserved in newMessages
        expect(result.newMessages).toHaveLength(1);
        expect(result.newMessages[0]).toEqual(thoughtResponse);
    });

    test("emits TRIAGE and GENERATING status updates on general route", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const generalModel = makeModel("response");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("content");
        const videoTool = makeTool("transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const updates: AgentStatusUpdate[] = [];
        await orchestrator.process([], "Hello", (u) => updates.push(u));

        expect(updates.map((u) => u.type)).toEqual([
            AgentStatusType.TRIAGE,
            AgentStatusType.GENERATING,
        ]);
    });

    test("emits TRIAGE and SEARCHING status updates on search route", async () => {
        const triageModel = makeTriageWithToolCall("route_to_search");
        const generalModel = makeModel("response");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("content");
        const videoTool = makeTool("transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const updates: AgentStatusUpdate[] = [];
        await orchestrator.process([], "What happened today?", (u) =>
            updates.push(u),
        );

        expect(updates.map((u) => u.type)).toEqual([
            AgentStatusType.TRIAGE,
            AgentStatusType.SEARCHING,
        ]);
    });

    test("emits TRIAGE, FETCHING_CONTENT, and GENERATING status updates on tool route", async () => {
        const triageModel = makeTriageWithToolCall("get_website", {
            urls: ["https://example.com"],
        });
        const generalModel = makeModel("summary");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("page content");
        const videoTool = makeTool("transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        const updates: AgentStatusUpdate[] = [];
        await orchestrator.process([], "Summarize example.com", (u) =>
            updates.push(u),
        );

        expect(updates.map((u) => u.type)).toEqual([
            AgentStatusType.TRIAGE,
            AgentStatusType.FETCHING_CONTENT,
            AgentStatusType.GENERATING,
        ]);
    });

    test("works without onStatusUpdate (backward compatible)", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const generalModel = makeModel("response");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("content");
        const videoTool = makeTool("transcript");

        const orchestrator = new Orchestrator(
            triageModel as never,
            generalModel as never,
            searchModel as never,
            websiteTool as never,
            videoTool as never,
            testLogger,
        );

        // Two-arg call must still work; no callback provided
        expect(orchestrator.process([], "Hello")).resolves.toBeDefined();
    });
});
