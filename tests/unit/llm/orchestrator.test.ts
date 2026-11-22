import { describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, ChatMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import pino from "pino";
import { dbMessagesToLangchain } from "../../../src/application/helpers/langchainMessageTransformers.ts";
import type {
    IResilientModelInvoker,
    ModelInvocationResult,
} from "../../../src/application/ports/IResilientModelInvoker.ts";
import type { AgentStatusUpdate } from "../../../src/application/types/AgentStatus.ts";
import { AgentStatusType } from "../../../src/application/types/AgentStatus.ts";
import type { PersistedChatMessage } from "../../../src/domain/entities/Message.ts";
import { AllFreeKeysExhaustedError, AppError } from "../../../src/domain/errors/AppError.ts";
import { FinishReason } from "../../../src/domain/value-objects/FinishReason.ts";
import { MessageIntent } from "../../../src/domain/value-objects/MessageIntent.ts";
import { AgentOrchestrator } from "../../../src/infrastructure/llm/agents/agentOrchestrator.ts";
import { ResilientModelInvoker } from "../../../src/infrastructure/llm/ResilientModelInvoker.ts";
import type { WebsiteResultEntry } from "../../../src/infrastructure/llm/tools/getWebsiteTool.ts";

const testLogger = pino({ level: "silent" });

const testConfig = {
    file: {
        attachmentDownloader: {
            timeoutMs: 10_000,
            memory: { maxSizeMB: 100 },
        },
        globalModelTimeoutMs: 600_000,
        geminiFileApi: {
            pollIntervalMs: 5_000,
            maxPollWaitMs: 120_000,
            fileStaleBeforeExpiryMinutes: 15,
            fileStaleBeforeExpiryMs: 15 * 60 * 1000,
        },
        discord: { chainLimit: 100, retries: 3, enableInDMs: false, rateLimits: [] },
        geminiModels: { includeThoughts: false },
        agent: {
            uploadAttachmentMode: "upload" as const,
            maxInlineAttachmentSizeMB: 100,
            maxInlineAttachmentSizeBytes: 100 * 1024 * 1024,
            maxExternalUrlFileSizeMB: 500,
            maxExternalUrlFileSizeBytes: 500 * 1024 * 1024,
            fallbackExecutionMode: "sequential" as const,
            searchMode: "google" as const,
            nodes: {
                triage: {
                    model: "gemini-test",
                    timeoutMs: 60_000,
                    thinkingLevel: "LOW" as const,
                    apiKeyType: "free" as const,
                },
                general: {
                    model: "gemini-test",
                    timeoutMs: 120_000,
                    apiKeyType: "free" as const,
                    isFallbackRetryable: true,
                },
                computation: {
                    model: "gemini-test",
                    timeoutMs: 120_000,
                    apiKeyType: "free" as const,
                    isFallbackRetryable: true,
                },
                googleSearch: {
                    model: "gemini-test",
                    timeoutMs: 120_000,
                    apiKeyType: "paid" as const,
                    isFallbackRetryable: true,
                },
            },
        },
        ytDlp: { retries: 1, timeoutMs: 300_000 },
        externalContent: { httpsOnly: true, blockPrivateAddresses: true, rewriteHttp: true },
        cache: { geminiFileUrls: 1000 },
        prompts: { basePrompt: "You are an AI assistant." },
    },
};

/** Wraps a single AIMessage in a one-chunk async iterable for stream() mocks. */
function makeStreamIterable(msg: AIMessage) {
    return {
        [Symbol.asyncIterator]: () => {
            let done = false;
            return {
                next: async () => {
                    if (done) return { done: true as const, value: undefined };
                    done = true;
                    return { done: false, value: msg };
                },
            };
        },
    };
}

/** Helper to create a mock model that returns a given response */
function makeModel(response: string) {
    const msg = new AIMessage(response);
    return {
        invoke: mock(async (_messages: BaseMessage[]) => msg),
        stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(msg)),
    };
}

/** Helper to create a mock tool that returns a successful single-entry result */
function makeTool(pageContents: string, url = "https://example.com"): { invoke: ReturnType<typeof mock> } {
    const result: WebsiteResultEntry[] = [{ url, pageContents }];
    return {
        invoke: mock(async (_args: unknown) => result),
    };
}

/** Helper to create a triage model mock that returns a specific tool call */
function makeTriageWithToolCall(toolName: string, toolArgs: Record<string, unknown> = {}) {
    const msg = new AIMessage({
        content: "",
        tool_calls: [{ name: toolName, args: toolArgs, id: "call_test_123", type: "tool_call" }],
    });
    return {
        invoke: mock(async (_messages: BaseMessage[]) => msg),
        stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(msg)),
    };
}

/** Helper to create a triage model mock that returns several tool calls, with Gemini-style content blocks */
function makeTriageWithToolCalls(toolCalls: { name: string; args: Record<string, unknown> }[]) {
    const msg = new AIMessage({
        content: toolCalls.map(({ name, args }) => ({ type: "functionCall", functionCall: { name, args } })),
        tool_calls: toolCalls.map((tc, i) => ({ ...tc, id: `call_test_${i}`, type: "tool_call" as const })),
    });
    return {
        invoke: mock(async (_messages: BaseMessage[]) => msg),
        stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(msg)),
    };
}

/** Helper to create a triage model mock with no tool call */
function makeTriageWithNoToolCall() {
    const msg = new AIMessage({ content: "I am confused", tool_calls: [] });
    return {
        invoke: mock(async (_messages: BaseMessage[]) => msg),
        stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(msg)),
    };
}

/**
 * Wraps a mock model in a minimal IModelProvider shell so it can be passed to
 * AgentOrchestrator's provider constructor params. `get()` always returns the
 * same model regardless of which key is passed, which is correct for tests
 * that do not exercise key rotation.
 */
function asProvider<T>(model: T) {
    return {
        get(_key: unknown): T {
            return model;
        },
        getFallback(_key: unknown): T | undefined {
            return undefined;
        },
    };
}

/** Minimal IRoundRobinKeyProvider stub — single key, no rotation side-effects. */
function makeFreeKeyProvider() {
    const key = { id: "free-key-id", apiKey: "free-key", isPaid: false, lastUsed: false };
    return {
        get currentKey() {
            return key;
        },
        nextKey() {
            return key;
        },
        get keyCount() {
            return 1;
        },
    };
}

/**
 * Wraps a free-key provider in a ResilientModelInvoker with upload mode disabled
 * (inline, zero byte limit) so no attachment filtering or file refresh occurs in tests.
 */
function makeInvoker(freeKeyProvider = makeFreeKeyProvider()) {
    return new ResilientModelInvoker(
        freeKeyProvider,
        makeFreeKeyProvider(),
        {
            attachmentMode: "inline" as const,
            maxInlineBytes: 0,
            globalTimeoutMs: 600_000,
            fallbackExecutionMode: "sequential" as const,
        },
        testLogger,
    );
}

describe("dbMessagesToLangchain", () => {
    const baseMsg: Omit<PersistedChatMessage, "role" | "langchainMessages"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        discordAuthorId: "",
        retriesLeft: null,
        usedFallback: null,
        interactionType: null,
        interactionAuthorDiscordId: null,
        createdAt: new Date(),
    };

    test("converts a serialized HumanMessage back to HumanMessage", () => {
        const original = new HumanMessage("Hello!");
        const records: PersistedChatMessage[] = [
            {
                ...baseMsg,
                role: "human",
                langchainMessages: [original.toJSON() as unknown as Record<string, unknown>],
            },
        ];
        const result = dbMessagesToLangchain(records, testLogger);
        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[0]?.content).toBe("Hello!");
    });

    test("converts a serialized AIMessage back to AIMessage", () => {
        const original = new AIMessage("Hi there!");
        const records: PersistedChatMessage[] = [
            {
                ...baseMsg,
                role: "assistant",
                langchainMessages: [original.toJSON() as unknown as Record<string, unknown>],
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
        const records: PersistedChatMessage[] = [
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
        const records: PersistedChatMessage[] = [
            {
                ...baseMsg,
                discordMessageId: "d1",
                role: "human",
                langchainMessages: [human.toJSON() as unknown as Record<string, unknown>],
            },
            {
                ...baseMsg,
                discordMessageId: "d2",
                role: "assistant",
                langchainMessages: [ai.toJSON() as unknown as Record<string, unknown>],
            },
            {
                ...baseMsg,
                discordMessageId: "d3",
                role: "human",
                langchainMessages: [humanFollow.toJSON() as unknown as Record<string, unknown>],
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
    const baseMsg: Omit<PersistedChatMessage, "role" | "langchainMessages"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        discordAuthorId: "",
        retriesLeft: null,
        usedFallback: null,
        interactionType: null,
        interactionAuthorDiscordId: null,
        createdAt: new Date(),
    };

    function singleRecord(json: Record<string, unknown>): PersistedChatMessage[] {
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
            singleRecord(original.toJSON() as unknown as Record<string, unknown>),
            testLogger,
        );
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[0]?.content).toBe("hello");
    });

    test("round-trips AIMessage", () => {
        const original = new AIMessage("hi");
        const result = dbMessagesToLangchain(
            singleRecord(original.toJSON() as unknown as Record<string, unknown>),
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
            singleRecord(original.toJSON() as unknown as Record<string, unknown>),
            testLogger,
        );
        expect(result[0]).toBeInstanceOf(ToolMessage);
        expect((result[0] as ToolMessage).tool_call_id).toBe("call_abc");
        expect(result[0]?.content).toBe("tool result");
    });

    test("throws AppError for SystemMessage", () => {
        const original = new SystemMessage("system prompt");
        expect(() =>
            dbMessagesToLangchain(singleRecord(original.toJSON() as unknown as Record<string, unknown>), testLogger),
        ).toThrow(AppError);
    });

    test("throws AppError for unknown message type", () => {
        const unknown: Record<string, unknown> = {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "WeirdMessage"],
            kwargs: { content: "hi" },
        };
        expect(() => dbMessagesToLangchain(singleRecord(unknown), testLogger)).toThrow(AppError);
    });

    test("round-trips ChatMessage and logs a warning", () => {
        const warnMock = mock(() => {});
        const mockLogger = {
            ...testLogger,
            warn: warnMock,
        } as typeof testLogger;

        const original = new ChatMessage({ content: "hi", role: "user" });
        const result = dbMessagesToLangchain(
            singleRecord(original.toJSON() as unknown as Record<string, unknown>),
            mockLogger,
        );
        expect(result[0]).toBeInstanceOf(ChatMessage);
        expect(warnMock).toHaveBeenCalledTimes(1);
    });
});

describe("dbMessagesToLangchain — thought chunk filtering", () => {
    const baseMsg: Omit<PersistedChatMessage, "role" | "langchainMessages"> = {
        id: "uuid-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        discordAuthorId: "",
        retriesLeft: null,
        usedFallback: null,
        interactionType: null,
        interactionAuthorDiscordId: null,
        createdAt: new Date(),
    };

    /** Serialized AIMessage with a thought chunk and a visible text chunk */
    function thoughtRecord(): PersistedChatMessage[] {
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
                langchainMessages: [msg.toJSON() as unknown as Record<string, unknown>],
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
        const [result] = dbMessagesToLangchain(thoughtRecord(), testLogger, false);
        const parts = result?.content as { type: string; thought?: boolean }[];
        expect(parts.some((p) => p.thought === true)).toBe(true);
        expect(parts).toHaveLength(2);
    });

    test("does not affect messages with string content", () => {
        const msg = new HumanMessage("plain text");
        const records: PersistedChatMessage[] = [
            {
                ...baseMsg,
                role: "human",
                langchainMessages: [msg.toJSON() as unknown as Record<string, unknown>],
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

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("What happened today?")], MessageIntent.UNKNOWN);

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

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("Tell me a joke")], MessageIntent.UNKNOWN);

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
        const websiteTool = makeTool("## https://example.com\n\nPage content here");
        const videoTool = makeTool("video transcript");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process(
            [new HumanMessage("Summarize https://example.com")],
            MessageIntent.UNKNOWN,
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

    test("calls get_video_captions tool and passes result to general model, returning 3 messages", async () => {
        const triageModel = makeTriageWithToolCall("get_video_captions", {
            urls: ["https://youtube.com/watch?v=abc"],
        });
        const generalModel = makeModel("video summary");
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool("## https://youtube.com/watch?v=abc\n\nTranscript here");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("Summarize this video")], MessageIntent.UNKNOWN);

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

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN);

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

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const history: BaseMessage[] = [new HumanMessage("First message"), new AIMessage("First response")];

        await orchestrator.process([...history, new HumanMessage("Follow-up question")], MessageIntent.UNKNOWN);

        const callArgs = (generalModel.invoke as ReturnType<typeof mock>).mock.calls[0]?.[0] as BaseMessage[];
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
            stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(thoughtResponse)),
        };
        const searchModel = makeModel("search response");
        const websiteTool = makeTool("website content");
        const videoTool = makeTool("video transcript");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("Think about this")], MessageIntent.UNKNOWN);

        // Thought chunks excluded from displayed content
        expect(result.content).toBe("The actual answer.");
        // But the full message (including thought) is preserved in newMessages
        expect(result.newMessages).toHaveLength(1);
        expect(result.newMessages[0]?.content).toEqual(thoughtResponse.content);
    });

    test("emits TRIAGE and GENERATING status updates on general route", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const generalModel = makeModel("response");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("content");
        const videoTool = makeTool("transcript");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const updates: AgentStatusUpdate[] = [];
        await orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN, (u) => updates.push(u));

        expect(updates.map((u) => u.type)).toEqual([AgentStatusType.TRIAGE, AgentStatusType.GENERATING]);
    });

    test("emits TRIAGE and SEARCHING status updates on search route", async () => {
        const triageModel = makeTriageWithToolCall("route_to_search");
        const generalModel = makeModel("response");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("content");
        const videoTool = makeTool("transcript");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const updates: AgentStatusUpdate[] = [];
        await orchestrator.process([new HumanMessage("What happened today?")], MessageIntent.UNKNOWN, (u) =>
            updates.push(u),
        );

        expect(updates.map((u) => u.type)).toEqual([AgentStatusType.TRIAGE, AgentStatusType.SEARCHING]);
    });

    test("emits TRIAGE, FETCHING_CONTENT, and GENERATING status updates on tool route", async () => {
        const triageModel = makeTriageWithToolCall("get_website", {
            urls: ["https://example.com"],
        });
        const generalModel = makeModel("summary");
        const searchModel = makeModel("search");
        const websiteTool = makeTool("page content");
        const videoTool = makeTool("transcript");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        const updates: AgentStatusUpdate[] = [];
        await orchestrator.process([new HumanMessage("Summarize example.com")], MessageIntent.UNKNOWN, (u) =>
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

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(searchModel) as never,
            makeInvoker(),
            websiteTool as never,
            videoTool as never,
            testLogger,
            testConfig,
        );

        // Two-arg call must still work; no callback provided
        expect(orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN)).resolves.toBeDefined();
    });
});

describe("Orchestrator.process — finishReason", () => {
    /** Mock model whose streamed message reports the given finishReason, as Gemini does. */
    function makeModelWithFinishReason(response: string, finishReason: string) {
        const msg = new AIMessage({ content: response, response_metadata: { finishReason } });
        return {
            invoke: mock(async (_messages: BaseMessage[]) => msg),
            stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(msg)),
        };
    }

    function makeOrchestratorWith(triageModel: unknown, generalModel: unknown) {
        return new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("search")) as never,
            makeInvoker(),
            makeTool("content") as never,
            makeTool("transcript") as never,
            testLogger,
            testConfig,
        );
    }

    test("surfaces a degraded reason from the answering node and marks it retryable", async () => {
        const orchestrator = makeOrchestratorWith(
            makeTriageWithToolCall("route_to_general"),
            makeModelWithFinishReason("partial answer", "SAFETY"),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN);

        expect(result.finishReason).toBe(FinishReason.SAFETY);
        expect(result.isRetryable).toBe(true);
        // An abnormal stop is not an interruption — the model did report a reason
        expect(result.wasInterrupted).toBe(false);
    });

    test("leaves the reason null on a clean stop so success is never reported as degraded", async () => {
        const orchestrator = makeOrchestratorWith(
            makeTriageWithToolCall("route_to_general"),
            makeModelWithFinishReason("complete answer", "STOP"),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN);

        expect(result.finishReason).toBeNull();
        expect(result.isRetryable).toBe(false);
        expect(result.wasInterrupted).toBe(false);
    });

    test("ignores a degraded triage reason when the answering node finishes cleanly", async () => {
        // A blocked triage call still routes to a node that produces a real answer,
        // so surfacing triage's reason to the user would be a false alarm.
        const triageModel = new AIMessage({
            content: "",
            tool_calls: [{ name: "route_to_general", args: {}, id: "call_1", type: "tool_call" as const }],
            response_metadata: { finishReason: "SAFETY" },
        });
        const orchestrator = makeOrchestratorWith(
            {
                invoke: mock(async (_messages: BaseMessage[]) => triageModel),
                stream: mock(async (_messages: BaseMessage[]) => makeStreamIterable(triageModel)),
            },
            makeModelWithFinishReason("complete answer", "STOP"),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN);

        expect(result.finishReason).toBeNull();
        expect(result.isRetryable).toBe(false);
    });
});

describe("Orchestrator.process — fallback retryability", () => {
    type AnsweringNode = "general" | "computation" | "googleSearch";

    /** testConfig with `isFallbackRetryable` set per answering node; unspecified nodes default to true. */
    function configWithFallbackRetryable(overrides: Partial<Record<AnsweringNode, boolean>>) {
        const { nodes } = testConfig.file.agent;
        return {
            file: {
                ...testConfig.file,
                agent: {
                    ...testConfig.file.agent,
                    nodes: {
                        ...nodes,
                        general: { ...nodes.general, isFallbackRetryable: overrides.general ?? true },
                        computation: { ...nodes.computation, isFallbackRetryable: overrides.computation ?? true },
                        googleSearch: { ...nodes.googleSearch, isFallbackRetryable: overrides.googleSearch ?? true },
                    },
                },
            },
        };
    }

    /**
     * Invoker stub that simulates fallback use without a real 503: triage calls get the given
     * routing sentinel, and every answering node call gets the given degradation flags.
     */
    function makeStubInvoker(
        answer: Pick<ModelInvocationResult, "usedFallback" | "wasInterrupted">,
        route = "route_to_general",
    ): IResilientModelInvoker {
        const invoke = mock(async (...args: Parameters<IResilientModelInvoker["invoke"]>) => {
            const beforeInvokeStatus = args[4]?.beforeInvokeStatus;
            if (beforeInvokeStatus === AgentStatusType.TRIAGE) {
                const triageResponse = new AIMessage({
                    content: "",
                    tool_calls: [{ name: route, args: {}, id: "call_route", type: "tool_call" as const }],
                });
                return { result: triageResponse, usedFallback: false, wasInterrupted: false, finishReason: null };
            }
            return {
                result: new AIMessage("answer"),
                ...answer,
                // An interruption is precisely the absence of a reported reason
                finishReason: answer.wasInterrupted ? null : FinishReason.STOP,
            };
        });
        return { invoke, invokeWithFreeKeys: invoke, invokeWithPaidKeys: invoke } as unknown as IResilientModelInvoker;
    }

    function makeOrchestratorWith(
        invoker: IResilientModelInvoker,
        config: ConstructorParameters<typeof AgentOrchestrator>[8],
    ) {
        return new AgentOrchestrator(
            asProvider(makeModel("triage")) as never,
            asProvider(makeModel("general")) as never,
            asProvider(makeModel("computation")) as never,
            asProvider(makeModel("search")) as never,
            invoker,
            makeTool("content") as never,
            makeTool("transcript") as never,
            testLogger,
            config,
        );
    }

    test("passes each node's own timeout and grace period to the invoker", async () => {
        const { nodes } = testConfig.file.agent;
        const invoker = makeStubInvoker({ usedFallback: false, wasInterrupted: false });
        const orchestrator = makeOrchestratorWith(invoker, {
            file: {
                ...testConfig.file,
                agent: {
                    ...testConfig.file.agent,
                    nodes: {
                        ...nodes,
                        triage: { ...nodes.triage, mainGracePeriodMs: 2_000 },
                        general: { ...nodes.general, mainGracePeriodMs: 15_000 },
                    },
                },
            },
        });

        await orchestrator.process([new HumanMessage("Hello")], MessageIntent.UNKNOWN);

        const calledOptions = (invoker.invoke as ReturnType<typeof mock>).mock.calls.map((args) => args[4]);
        expect(calledOptions).toEqual([
            expect.objectContaining({
                timeoutMs: nodes.triage.timeoutMs,
                mainGracePeriodMs: 2_000,
                beforeInvokeStatus: AgentStatusType.TRIAGE,
            }),
            expect.objectContaining({
                timeoutMs: nodes.general.timeoutMs,
                mainGracePeriodMs: 15_000,
                beforeInvokeStatus: AgentStatusType.GENERATING,
            }),
        ]);
    });

    test("marks a fallback response retryable when the node allows it", async () => {
        const orchestrator = makeOrchestratorWith(
            makeStubInvoker({ usedFallback: true, wasInterrupted: false }),
            configWithFallbackRetryable({ general: true }),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.GENERAL);

        expect(result.isRetryable).toBe(true);
        expect(result.usedFallback).toBe(true);
        expect(result.usedRetryableFallback).toBe(true);
    });

    test("treats a fallback response as final when the node disallows it, but still reports the fallback", async () => {
        const orchestrator = makeOrchestratorWith(
            makeStubInvoker({ usedFallback: true, wasInterrupted: false }),
            configWithFallbackRetryable({ general: false }),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.GENERAL);

        expect(result.isRetryable).toBe(false);
        expect(result.usedFallback).toBe(true);
        expect(result.usedRetryableFallback).toBe(false);
    });

    test("keeps an interrupted fallback response retryable even when the node disallows fallback retries", async () => {
        const orchestrator = makeOrchestratorWith(
            makeStubInvoker({ usedFallback: true, wasInterrupted: true }),
            configWithFallbackRetryable({ general: false }),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.GENERAL);

        expect(result.isRetryable).toBe(true);
        expect(result.usedFallback).toBe(true);
        expect(result.wasInterrupted).toBe(true);
        // Retryable because of the interruption, not the fallback
        expect(result.usedRetryableFallback).toBe(false);
    });

    test("flags the fallback as a retry reason when an interrupted response also allows fallback retries", async () => {
        const orchestrator = makeOrchestratorWith(
            makeStubInvoker({ usedFallback: true, wasInterrupted: true }),
            configWithFallbackRetryable({ general: true }),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.GENERAL);

        expect(result.isRetryable).toBe(true);
        expect(result.usedRetryableFallback).toBe(true);
        expect(result.wasInterrupted).toBe(true);
    });

    test("never flags a retryable fallback when the primary model answered", async () => {
        const orchestrator = makeOrchestratorWith(
            makeStubInvoker({ usedFallback: false, wasInterrupted: true }),
            configWithFallbackRetryable({ general: true }),
        );

        const result = await orchestrator.process([new HumanMessage("Hello")], MessageIntent.GENERAL);

        expect(result.isRetryable).toBe(true);
        expect(result.usedFallback).toBe(false);
        expect(result.usedRetryableFallback).toBe(false);
    });

    test.each([
        { node: "general" as const, intent: MessageIntent.GENERAL, route: "route_to_general" },
        { node: "computation" as const, intent: MessageIntent.UNKNOWN, route: "route_to_python" },
        { node: "googleSearch" as const, intent: MessageIntent.SEARCH, route: "route_to_search" },
    ])("the $node node reads only its own setting", async ({ node, intent, route }) => {
        const invoker = makeStubInvoker({ usedFallback: true, wasInterrupted: false }, route);

        // Disabled on this node only — the other nodes' enabled settings must not leak in
        const disabledHere = await makeOrchestratorWith(
            invoker,
            configWithFallbackRetryable({ [node]: false }),
        ).process([new HumanMessage("Hello")], intent);
        expect(disabledHere.isRetryable).toBe(false);
        expect(disabledHere.usedRetryableFallback).toBe(false);

        // Enabled on this node only — the other nodes' disabled settings must not leak in
        const enabledHereOnly = await makeOrchestratorWith(
            invoker,
            configWithFallbackRetryable({ general: false, computation: false, googleSearch: false, [node]: true }),
        ).process([new HumanMessage("Hello")], intent);
        expect(enabledHereOnly.isRetryable).toBe(true);
        expect(enabledHereOnly.usedRetryableFallback).toBe(true);
    });
});

describe("invokeWithFreeKeyRotation — concurrent rotation", () => {
    /** An error shape that isKeyRotationError() recognizes as a rate limit. */
    const make429Error = () => Object.assign(new Error("Too Many Requests"), { statusCode: 429 });

    /**
     * Creates an IRoundRobinKeyProvider with `n` distinct keys backed by a shared
     * index. `nextKey` is a bun mock so call counts are observable.
     * `forceAdvance()` mutates the index directly, simulating a concurrent
     * request advancing the cursor between an invoke and the catch handler.
     */
    function makeMultiKeyProvider(n: number) {
        type Key = { id: string; apiKey: string; isPaid: false; lastUsed: false };
        const keys: Key[] = Array.from({ length: n }, (_, i) => ({
            id: `key-${i}`,
            apiKey: `k${i}`,
            isPaid: false as const,
            lastUsed: false as const,
        }));
        let idx = 0;
        // idx is always in [0, n-1] via modulo, so keys[idx] is always defined.
        const atIdx = (): Key => keys[idx] as Key;
        const nextKeySpy = mock(() => {
            idx = (idx + 1) % n;
            return atIdx();
        });
        return {
            get currentKey() {
                return atIdx();
            },
            nextKey: nextKeySpy,
            get keyCount() {
                return n;
            },
            /** Simulates a concurrent request rotating the cursor. */
            forceAdvance() {
                idx = (idx + 1) % n;
            },
        };
    }

    /** Minimal orchestrator wired to a given triage + general model pair. */
    function makeOrchestrator(
        triageModel: ReturnType<typeof makeTriageWithNoToolCall>,
        generalModel: { invoke: ReturnType<typeof mock> },
        provider: ReturnType<typeof makeMultiKeyProvider>,
    ) {
        return new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("search")) as never,
            makeInvoker(provider),
            makeTool("w") as never,
            makeTool("v") as never,
            testLogger,
            testConfig,
        );
    }

    test("calls nextKey() and retries with new key after 429 (normal rotation)", async () => {
        const provider = makeMultiKeyProvider(2);
        let generalCallCount = 0;
        const generalModel = {
            invoke: mock(async () => {
                generalCallCount++;
                if (generalCallCount === 1) throw make429Error();
                return new AIMessage("success on second key");
            }),
            stream: mock(async () => makeStreamIterable(new AIMessage(""))),
        };

        const result = await makeOrchestrator(makeTriageWithNoToolCall(), generalModel, provider).process(
            [new HumanMessage("hello")],
            MessageIntent.UNKNOWN,
        );

        expect(result.content).toBe("success on second key");
        expect(provider.nextKey).toHaveBeenCalledTimes(1);
        expect(generalCallCount).toBe(2);
    });

    test("skips nextKey() when cursor was already advanced by a concurrent request", async () => {
        const provider = makeMultiKeyProvider(2);
        let generalCallCount = 0;
        const generalModel = {
            invoke: mock(async () => {
                generalCallCount++;
                if (generalCallCount === 1) {
                    // Simulate another concurrent request advancing the cursor
                    // before our catch handler runs.
                    provider.forceAdvance();
                    throw make429Error();
                }
                return new AIMessage("success on concurrent-advanced key");
            }),
            stream: mock(async () => makeStreamIterable(new AIMessage(""))),
        };

        const result = await makeOrchestrator(makeTriageWithNoToolCall(), generalModel, provider).process(
            [new HumanMessage("hello")],
            MessageIntent.UNKNOWN,
        );

        expect(result.content).toBe("success on concurrent-advanced key");
        // Cursor was already moved by the concurrent advance — nextKey() must
        // not be called again, otherwise the newly-current key would be skipped.
        expect(provider.nextKey).not.toHaveBeenCalled();
        expect(generalCallCount).toBe(2);
    });

    test("throws AllFreeKeysExhaustedError when all keys return 429", async () => {
        const provider = makeMultiKeyProvider(2);
        const generalModel = {
            invoke: mock(async () => {
                throw make429Error();
            }),
            stream: mock(async () => makeStreamIterable(new AIMessage(""))),
        };

        let thrown: unknown;
        try {
            await makeOrchestrator(makeTriageWithNoToolCall(), generalModel, provider).process(
                [new HumanMessage("hello")],
                MessageIntent.UNKNOWN,
            );
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(AllFreeKeysExhaustedError);
    });

    test("rotates to next key when fallback model returns 429 after primary 503", async () => {
        const make503Error = () => new Error("HTTP 503 Service Unavailable");
        const provider = makeMultiKeyProvider(2);
        let generalCallCount = 0;
        // Primary always 503s, so fallback is tried. Fallback 429s on first key, succeeds on second.
        const fallbackInvoke = mock(async () => {
            if (generalCallCount === 1) throw make429Error();
            return new AIMessage("success from fallback on second key");
        });
        const generalModel = {
            invoke: mock(async () => {
                generalCallCount++;
                throw make503Error();
            }),
            stream: mock(async () => makeStreamIterable(new AIMessage(""))),
        };
        const generalProvider = {
            get(_key: unknown) {
                return generalModel;
            },
            getFallback(_key: unknown) {
                return { invoke: fallbackInvoke, stream: mock(async () => makeStreamIterable(new AIMessage(""))) };
            },
        };

        const orchestrator = new AgentOrchestrator(
            asProvider(makeTriageWithNoToolCall()) as never,
            generalProvider as never,
            generalProvider as never,
            asProvider(makeModel("search")) as never,
            makeInvoker(provider),
            makeTool("w") as never,
            makeTool("v") as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("hello")], MessageIntent.UNKNOWN);

        expect(result.content).toBe("success from fallback on second key");
        // nextKey() called once: fallback on key-0 returned 429, rotate to key-1
        expect(provider.nextKey).toHaveBeenCalledTimes(1);
        expect(fallbackInvoke).toHaveBeenCalledTimes(2);
    });

    test("throws AllFreeKeysExhaustedError when all fallback model invocations return 429", async () => {
        const make503Error = () => new Error("HTTP 503 Service Unavailable");
        const provider = makeMultiKeyProvider(2);
        const generalModel = {
            invoke: mock(async () => {
                throw make503Error();
            }),
            stream: mock(async () => makeStreamIterable(new AIMessage(""))),
        };
        const generalProvider = {
            get(_key: unknown) {
                return generalModel;
            },
            getFallback(_key: unknown) {
                return {
                    invoke: mock(async () => {
                        throw make429Error();
                    }),
                    stream: mock(async () => makeStreamIterable(new AIMessage(""))),
                };
            },
        };

        const orchestrator = new AgentOrchestrator(
            asProvider(makeTriageWithNoToolCall()) as never,
            generalProvider as never,
            generalProvider as never,
            asProvider(makeModel("search")) as never,
            makeInvoker(provider),
            makeTool("w") as never,
            makeTool("v") as never,
            testLogger,
            testConfig,
        );

        let thrown: unknown;
        try {
            await orchestrator.process([new HumanMessage("hello")], MessageIntent.UNKNOWN);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(AllFreeKeysExhaustedError);
    });
});

describe("Orchestrator.process — tool exchange flattening", () => {
    const tavilyConfig = {
        file: {
            ...testConfig.file,
            agent: { ...testConfig.file.agent, searchMode: "tavily" as const },
        },
    };

    /** Returns the message list the given mock model was first invoked with. */
    function firstInvocationMessages(model: { invoke: ReturnType<typeof mock> }): BaseMessage[] {
        const messages = model.invoke.mock.calls[0]?.[0] as BaseMessage[] | undefined;
        expect(messages).toBeDefined();
        return messages ?? [];
    }

    /** True when the history still holds a tool call or tool response the model could imitate. */
    function hasToolExchange(messages: BaseMessage[]): boolean {
        return messages.some(
            (m) => m instanceof ToolMessage || (m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0),
        );
    }

    test("general node sees past tool exchanges as plain HumanMessages", async () => {
        const triageModel = makeTriageWithToolCall("route_to_general");
        const generalModel = makeModel("follow-up answer");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("search response")) as never,
            makeInvoker(),
            makeTool("website content") as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const history: BaseMessage[] = [
            new HumanMessage("Summarize https://example.com"),
            new AIMessage({
                content: "",
                tool_calls: [
                    { name: "get_website", args: { urls: ["https://example.com"] }, id: "c1", type: "tool_call" },
                ],
            }),
            new ToolMessage({
                content: JSON.stringify([{ url: "https://example.com", pageContents: "Page" }]),
                name: "get_website",
                tool_call_id: "c1",
            }),
            new AIMessage("It is a page."),
        ];

        const result = await orchestrator.process(
            [...history, new HumanMessage("Tell me more")],
            MessageIntent.UNKNOWN,
        );

        const invoked = firstInvocationMessages(generalModel);
        expect(hasToolExchange(invoked)).toBe(false);
        expect(invoked.map((m) => m.type)).toEqual(["system", "human", "human", "ai", "human"]);
        expect(invoked[2]?.content).toBe("Website contents of https://example.com:\nPage");
        expect(result.newMessages).toHaveLength(1);
    });

    test("general node flattens the current turn's content fetch but state keeps the original messages", async () => {
        const triageModel = makeTriageWithToolCall("get_website", { urls: ["https://example.com"] });
        const generalModel = makeModel("summary of website");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("search response")) as never,
            makeInvoker(),
            makeTool("Page body") as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process(
            [new HumanMessage("Summarize https://example.com")],
            MessageIntent.UNKNOWN,
        );

        const invoked = firstInvocationMessages(generalModel);
        expect(hasToolExchange(invoked)).toBe(false);
        expect(invoked.at(-1)?.content).toBe("Website contents of https://example.com:\nPage body");

        const [triageMessage, toolMessage, answer] = result.newMessages;
        expect(triageMessage).toBeInstanceOf(AIMessage);
        expect((triageMessage as AIMessage).tool_calls).toHaveLength(1);
        expect(toolMessage).toBeInstanceOf(ToolMessage);
        expect(answer?.content).toBe("summary of website");
    });

    test("general node flattens the current tavily search result but state keeps the tool exchange", async () => {
        const triageModel = makeTriageWithToolCall("web_search", { query: "latest news" });
        const generalModel = makeModel("search answer");
        const googleSearchModel = makeModel("google search response");
        const tavilyTool = {
            invoke: mock(async (_args: unknown) => [{ url: "https://a.com", title: "A", content: "news" }]),
        };

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("computation response")) as never,
            asProvider(googleSearchModel) as never,
            makeInvoker(),
            makeTool("website content") as never,
            makeTool("video transcript") as never,
            testLogger,
            tavilyConfig,
            tavilyTool as never,
        );

        const result = await orchestrator.process([new HumanMessage("What's new?")], MessageIntent.UNKNOWN);

        expect(tavilyTool.invoke).toHaveBeenCalledWith({ query: "latest news" });
        // In Tavily mode the general model answers from the results; the Google Search model is unused
        expect(googleSearchModel.invoke).not.toHaveBeenCalled();
        const invoked = firstInvocationMessages(generalModel);
        expect(hasToolExchange(invoked)).toBe(false);
        expect(invoked.map((m) => m.type)).toEqual(["system", "human", "human"]);
        expect(invoked[0]?.content).toContain("Web search results for the request are provided as context");
        expect(invoked[2]?.content).toBe("Web search context:\n[1] A (https://a.com)\nnews");

        // triage AIMessage + ToolMessage + final AIMessage are persisted unchanged
        expect(result.newMessages.map((m) => m.type)).toEqual(["ai", "tool", "ai"]);
        expect(result.content).toBe("search answer");
    });

    /** Maps a search query to the result set the Tavily tool yields, and records every query it receives. */
    function makeTavilyTool(resultsByQuery: Record<string, { url: string; title: string; content: string }[]>) {
        return { invoke: mock(async ({ query }: { query: string }) => resultsByQuery[query] ?? []) };
    }

    /** Tavily-mode orchestrator; `generalModel` is the one answering from search results. */
    function makeTavilyOrchestrator(
        triageModel: ReturnType<typeof makeTriageWithToolCalls>,
        generalModel: ReturnType<typeof makeModel>,
        tavilyTool: ReturnType<typeof makeTavilyTool>,
        computationModel = makeModel("computation response"),
    ) {
        return new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(computationModel) as never,
            asProvider(makeModel("google search response")) as never,
            makeInvoker(),
            makeTool("website content") as never,
            makeTool("video transcript") as never,
            testLogger,
            tavilyConfig,
            tavilyTool as never,
        );
    }

    test("tools node runs every web_search call and answers each with a ToolMessage", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "web_search", args: { query: "first" } },
            { name: "web_search", args: { query: "second" } },
        ]);
        const searchModel = makeModel("search answer");
        const tavilyTool = makeTavilyTool({
            first: [{ url: "https://a.com", title: "A", content: "from first" }],
            second: [{ url: "https://b.com", title: "B", content: "from second" }],
        });

        const result = await makeTavilyOrchestrator(triageModel, searchModel, tavilyTool).process(
            [new HumanMessage("Compare these")],
            MessageIntent.UNKNOWN,
        );

        expect(tavilyTool.invoke).toHaveBeenCalledTimes(2);
        expect(tavilyTool.invoke).toHaveBeenCalledWith({ query: "first" });
        expect(tavilyTool.invoke).toHaveBeenCalledWith({ query: "second" });

        // Both results reach the model, in one flattened message
        const invoked = firstInvocationMessages(searchModel);
        expect(hasToolExchange(invoked)).toBe(false);
        expect(invoked[2]?.content).toContain("from first");
        expect(invoked[2]?.content).toContain("from second");

        expect(result.newMessages.map((m) => m.type)).toEqual(["ai", "tool", "tool", "ai"]);
        const [triageMessage, firstTool, secondTool] = result.newMessages;
        expect((triageMessage as AIMessage).tool_calls).toHaveLength(2);
        expect((firstTool as ToolMessage).tool_call_id).toBe("call_test_0");
        expect((firstTool as ToolMessage).content).toContain("from first");
        expect((secondTool as ToolMessage).tool_call_id).toBe("call_test_1");
        expect((secondTool as ToolMessage).content).toContain("from second");
    });

    test("a source found by several searches is listed once", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "web_search", args: { query: "first" } },
            { name: "web_search", args: { query: "second" } },
        ]);
        const shared = { url: "https://shared.com", title: "Shared", content: "both" };
        const tavilyTool = makeTavilyTool({
            first: [shared],
            second: [shared, { url: "https://b.com", title: "B", content: "only second" }],
        });

        const result = await makeTavilyOrchestrator(triageModel, makeModel("search answer"), tavilyTool).process(
            [new HumanMessage("Compare these")],
            MessageIntent.UNKNOWN,
        );

        const answer = result.newMessages.at(-1) as AIMessage;
        expect(answer.additional_kwargs.groundingMetadata).toEqual({
            groundingChunks: [
                { web: { uri: "https://shared.com", title: "shared.com" } },
                { web: { uri: "https://b.com", title: "b.com" } },
            ],
        });
    });

    test("triage drops a routing sentinel accompanying web_search from both tool_calls and content", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "web_search", args: { query: "first" } },
            { name: "route_to_general", args: {} },
        ]);
        const tavilyTool = makeTavilyTool({
            first: [{ url: "https://a.com", title: "A", content: "from first" }],
        });

        const result = await makeTavilyOrchestrator(triageModel, makeModel("search answer"), tavilyTool).process(
            [new HumanMessage("What's new?")],
            MessageIntent.UNKNOWN,
        );

        expect(result.content).toBe("search answer");
        expect(result.newMessages.map((m) => m.type)).toEqual(["ai", "tool", "ai"]);
        const triageMessage = result.newMessages[0] as AIMessage;
        expect(triageMessage.tool_calls?.map((tc) => tc.name)).toEqual(["web_search"]);
        expect(triageMessage.content).toEqual([
            { type: "functionCall", functionCall: { name: "web_search", args: { query: "first" } } },
        ]);
    });

    test("triage drops a sentinel accompanying a content tool from both tool_calls and content", async () => {
        const url = "https://example.com/page";
        const triageModel = makeTriageWithToolCalls([
            { name: "route_to_general", args: {} },
            { name: "get_website", args: { urls: [url] } },
        ]);

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(makeModel("general response")) as never,
            asProvider(makeModel("computation response")) as never,
            asProvider(makeModel("search answer")) as never,
            makeInvoker(),
            makeTool("website content") as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process([new HumanMessage("Summarize this")], MessageIntent.UNKNOWN);

        const triageMessage = result.newMessages[0] as AIMessage;
        expect(triageMessage.tool_calls?.map((tc) => tc.name)).toEqual(["get_website"]);
        expect(triageMessage.content).toEqual([
            { type: "functionCall", functionCall: { name: "get_website", args: { urls: [url] } } },
        ]);
    });

    test("a sentinel preceding web_search does not keep the search from running", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "route_to_general", args: {} },
            { name: "web_search", args: { query: "first" } },
        ]);
        const tavilyTool = makeTavilyTool({
            first: [{ url: "https://a.com", title: "A", content: "from first" }],
        });

        const result = await makeTavilyOrchestrator(triageModel, makeModel("search answer"), tavilyTool).process(
            [new HumanMessage("What's new?")],
            MessageIntent.UNKNOWN,
        );

        expect(tavilyTool.invoke).toHaveBeenCalledWith({ query: "first" });
        expect(result.content).toBe("search answer");
        expect((result.newMessages[0] as AIMessage).tool_calls?.map((tc) => tc.name)).toEqual(["web_search"]);
    });

    test("runs content tools and web_search of the same turn, and answers both with the general node", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "get_website", args: { urls: ["https://example.com"] } },
            { name: "web_search", args: { query: "first" } },
        ]);
        const generalModel = makeModel("combined answer");
        const websiteTool = makeTool("Page body");
        const tavilyTool = makeTavilyTool({
            first: [{ url: "https://a.com", title: "A", content: "from first" }],
        });

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("computation response")) as never,
            asProvider(makeModel("google search response")) as never,
            makeInvoker(),
            websiteTool as never,
            makeTool("video transcript") as never,
            testLogger,
            tavilyConfig,
            tavilyTool as never,
        );

        const updates: AgentStatusUpdate[] = [];
        const result = await orchestrator.process(
            [new HumanMessage("Compare https://example.com with the news")],
            MessageIntent.UNKNOWN,
            (u) => updates.push(u),
        );

        expect(websiteTool.invoke).toHaveBeenCalledWith({ urls: ["https://example.com"] });
        expect(tavilyTool.invoke).toHaveBeenCalledWith({ query: "first" });
        expect(result.content).toBe("combined answer");
        // The search takes status priority over the content fetch running alongside it
        expect(updates.map((u) => u.type)).toEqual([
            AgentStatusType.TRIAGE,
            AgentStatusType.SEARCHING,
            AgentStatusType.GENERATING,
        ]);
        expect(result.newMessages.map((m) => m.type)).toEqual(["ai", "tool", "tool", "ai"]);

        // Both results reach the model, along with the instructions for each kind of context
        const invoked = firstInvocationMessages(generalModel);
        expect(hasToolExchange(invoked)).toBe(false);
        expect(invoked[0]?.content).toContain("If retrieving all of the linked content failed");
        expect(invoked[0]?.content).toContain("Web search results for the request are provided as context");
        expect(invoked[2]?.content).toContain("Website contents of https://example.com:\nPage body");
        expect(invoked[2]?.content).toContain("from first");

        // Only the search contributes sources
        const answer = result.newMessages.at(-1) as AIMessage;
        expect(answer.additional_kwargs.groundingMetadata).toEqual({
            groundingChunks: [{ web: { uri: "https://a.com", title: "a.com" } }],
        });
    });

    test("a routing sentinel accompanying web_search picks the node that answers from its results", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "web_search", args: { query: "first" } },
            { name: "route_to_python", args: {} },
        ]);
        const generalModel = makeModel("general response");
        const computationModel = makeModel("computed answer");
        const tavilyTool = makeTavilyTool({
            first: [{ url: "https://a.com", title: "A", content: "from first" }],
        });

        const result = await makeTavilyOrchestrator(triageModel, generalModel, tavilyTool, computationModel).process(
            [new HumanMessage("Plot the latest numbers")],
            MessageIntent.UNKNOWN,
        );

        expect(generalModel.invoke).not.toHaveBeenCalled();
        expect(result.content).toBe("computed answer");
        expect(firstInvocationMessages(computationModel)[2]?.content).toContain("from first");
        // The sentinel is not persisted, and the sources are cited whichever node answers
        expect((result.newMessages[0] as AIMessage).tool_calls?.map((tc) => tc.name)).toEqual(["web_search"]);
        expect((result.newMessages.at(-1) as AIMessage).additional_kwargs.groundingMetadata).toEqual({
            groundingChunks: [{ web: { uri: "https://a.com", title: "a.com" } }],
        });
    });

    test("google mode fetches content first when route_to_search accompanies a content tool", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "get_website", args: { urls: ["https://example.com"] } },
            { name: "route_to_search", args: {} },
        ]);
        const generalModel = makeModel("general response");
        const googleSearchModel = makeModel("grounded answer");
        const websiteTool = makeTool("Page body");
        const updates: AgentStatusUpdate[] = [];

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(makeModel("computation response")) as never,
            asProvider(googleSearchModel) as never,
            makeInvoker(),
            websiteTool as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process(
            [new HumanMessage("Fact check https://example.com")],
            MessageIntent.UNKNOWN,
            (u) => updates.push(u),
        );

        expect(websiteTool.invoke).toHaveBeenCalledWith({ urls: ["https://example.com"] });
        expect(generalModel.invoke).not.toHaveBeenCalled();
        expect(result.content).toBe("grounded answer");
        expect(updates.map((u) => u.type)).toEqual([
            AgentStatusType.TRIAGE,
            AgentStatusType.FETCHING_CONTENT,
            AgentStatusType.SEARCHING,
        ]);

        // The Google Search model gets the fetched page and the instructions for handling it
        const invoked = firstInvocationMessages(googleSearchModel);
        expect(invoked[0]?.content).toContain("If retrieving all of the linked content failed");
        expect(invoked.at(-1)?.content).toBe("Website contents of https://example.com:\nPage body");

        // Only the content call is persisted, without the sentinel
        expect(result.newMessages.map((m) => m.type)).toEqual(["ai", "tool", "ai"]);
        const triageMessage = result.newMessages[0] as AIMessage;
        expect(triageMessage.tool_calls?.map((tc) => tc.name)).toEqual(["get_website"]);
        expect(triageMessage.content).toEqual([
            { type: "functionCall", functionCall: { name: "get_website", args: { urls: ["https://example.com"] } } },
        ]);
    });

    test("fetches content first when route_to_python accompanies a content tool", async () => {
        const triageModel = makeTriageWithToolCalls([
            { name: "route_to_python", args: {} },
            { name: "get_website", args: { urls: ["https://example.com"] } },
        ]);
        const generalModel = makeModel("general response");
        const computationModel = makeModel("computed answer");

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(generalModel) as never,
            asProvider(computationModel) as never,
            asProvider(makeModel("google search response")) as never,
            makeInvoker(),
            makeTool("Page body") as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const result = await orchestrator.process(
            [new HumanMessage("Plot the numbers from https://example.com")],
            MessageIntent.UNKNOWN,
        );

        expect(generalModel.invoke).not.toHaveBeenCalled();
        expect(result.content).toBe("computed answer");
        expect(firstInvocationMessages(computationModel).at(-1)?.content).toBe(
            "Website contents of https://example.com:\nPage body",
        );
    });

    test("tavily search reports SEARCHING while the search runs and GENERATING for the answer", async () => {
        const triageModel = makeTriageWithToolCalls([{ name: "web_search", args: { query: "first" } }]);
        const updates: AgentStatusUpdate[] = [];

        await makeTavilyOrchestrator(triageModel, makeModel("search answer"), makeTavilyTool({})).process(
            [new HumanMessage("What's new?")],
            MessageIntent.SEARCH,
            (u) => updates.push(u),
        );

        expect(updates.map((u) => u.type)).toEqual([
            AgentStatusType.TRIAGE,
            AgentStatusType.SEARCHING,
            AgentStatusType.GENERATING,
        ]);
    });

    test("tavily mode has no Google Search node to route to, so route_to_search falls back to general", async () => {
        const generalModel = makeModel("general response");
        const orchestrator = makeTavilyOrchestrator(
            makeTriageWithToolCalls([{ name: "route_to_search", args: {} }]),
            generalModel,
            makeTavilyTool({}),
        );

        const result = await orchestrator.process([new HumanMessage("What's new?")], MessageIntent.UNKNOWN);

        expect(result.content).toBe("general response");
        expect(result.newMessages).toHaveLength(1);
    });

    test("tavily mode tells the triage model when the user explicitly requested a search", async () => {
        const SEARCH_REQUESTED = "The user explicitly requested a web search";
        const triagePrompt = async (intent: MessageIntent, withSearchIntentProvider: boolean) => {
            const triageModel = makeTriageWithToolCalls([{ name: "web_search", args: { query: "first" } }]);
            const orchestrator = new AgentOrchestrator(
                asProvider(triageModel) as never,
                asProvider(makeModel("general response")) as never,
                asProvider(makeModel("computation response")) as never,
                asProvider(makeModel("google search response")) as never,
                makeInvoker(),
                makeTool("website content") as never,
                makeTool("video transcript") as never,
                testLogger,
                tavilyConfig,
                makeTavilyTool({}) as never,
                withSearchIntentProvider ? (asProvider(triageModel) as never) : undefined,
            );
            await orchestrator.process([new HumanMessage("What's new?")], intent);
            return String(firstInvocationMessages(triageModel)[0]?.content);
        };

        expect(await triagePrompt(MessageIntent.SEARCH, true)).toContain(SEARCH_REQUESTED);
        expect(await triagePrompt(MessageIntent.UNKNOWN, true)).not.toContain(SEARCH_REQUESTED);
        // Without the dedicated model, the regular triage model keeps its regular prompt
        expect(await triagePrompt(MessageIntent.SEARCH, false)).not.toContain(SEARCH_REQUESTED);
    });

    test("refuses to be constructed in tavily mode without a tavily tool", () => {
        expect(
            () =>
                new AgentOrchestrator(
                    asProvider(makeModel("triage")) as never,
                    asProvider(makeModel("general")) as never,
                    asProvider(makeModel("computation")) as never,
                    asProvider(makeModel("search")) as never,
                    makeInvoker(),
                    makeTool("website content") as never,
                    makeTool("video transcript") as never,
                    testLogger,
                    tavilyConfig,
                ),
        ).toThrow(AppError);
    });

    test("computation node sees past tool exchanges as plain HumanMessages", async () => {
        const computationModel = makeModel("42");

        const orchestrator = new AgentOrchestrator(
            asProvider(makeTriageWithToolCall("route_to_python")) as never,
            asProvider(makeModel("general response")) as never,
            asProvider(computationModel) as never,
            asProvider(makeModel("search response")) as never,
            makeInvoker(),
            makeTool("website content") as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const history: BaseMessage[] = [
            new HumanMessage("Summarize https://example.com"),
            new AIMessage({
                content: "",
                tool_calls: [
                    { name: "get_website", args: { urls: ["https://example.com"] }, id: "c1", type: "tool_call" },
                ],
            }),
            new ToolMessage({
                content: JSON.stringify([{ url: "https://example.com", pageContents: "Page" }]),
                name: "get_website",
                tool_call_id: "c1",
            }),
            new AIMessage("It is a page."),
        ];

        await orchestrator.process([...history, new HumanMessage("Now compute 6 * 7")], MessageIntent.UNKNOWN);

        const invoked = firstInvocationMessages(computationModel);
        expect(hasToolExchange(invoked)).toBe(false);
        expect(invoked.map((m) => m.type)).toEqual(["system", "human", "human", "ai", "human"]);
    });

    test("fetches only URLs that are not in history yet, and persists the call as it was executed", async () => {
        const fetchedUrl = "https://example.com/old";
        const newUrl = "https://example.com/new";
        const triageModel = makeTriageWithToolCalls([{ name: "get_website", args: { urls: [fetchedUrl, newUrl] } }]);
        const websiteTool = makeTool("New page", newUrl);

        const orchestrator = new AgentOrchestrator(
            asProvider(triageModel) as never,
            asProvider(makeModel("general response")) as never,
            asProvider(makeModel("computation response")) as never,
            asProvider(makeModel("search response")) as never,
            makeInvoker(),
            websiteTool as never,
            makeTool("video transcript") as never,
            testLogger,
            testConfig,
        );

        const history: BaseMessage[] = [
            new HumanMessage(`Summarize ${fetchedUrl}`),
            new AIMessage({
                content: "",
                tool_calls: [{ name: "get_website", args: { urls: [fetchedUrl] }, id: "c1", type: "tool_call" }],
            }),
            new ToolMessage({
                content: JSON.stringify([{ url: fetchedUrl, pageContents: "Old page" }]),
                name: "get_website",
                tool_call_id: "c1",
            }),
            new AIMessage("It is an old page."),
        ];

        const result = await orchestrator.process(
            [...history, new HumanMessage(`Compare it with ${newUrl}`)],
            MessageIntent.UNKNOWN,
        );

        expect(websiteTool.invoke).toHaveBeenCalledTimes(1);
        expect(websiteTool.invoke).toHaveBeenCalledWith({ urls: [newUrl] });

        // Both representations of the call agree on what was fetched
        const triageMessage = result.newMessages[0] as AIMessage;
        expect(triageMessage.tool_calls?.map((tc) => tc.args)).toEqual([{ urls: [newUrl] }]);
        expect(triageMessage.content).toEqual([
            { type: "functionCall", functionCall: { name: "get_website", args: { urls: [newUrl] } } },
        ]);
    });
});
