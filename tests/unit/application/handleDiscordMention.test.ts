import { describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import type { IAgentOrchestrator } from "../../../src/application/ports/IAgentOrchestrator.ts";
import type { IAttachmentDownloader } from "../../../src/application/ports/IAttachmentDownloader.ts";
import type {
    DiscordMessageSnapshot,
    IChatMessageService,
} from "../../../src/application/ports/IChatMessageService.ts";
import type { OnStatusUpdate } from "../../../src/application/types/AgentStatus.ts";
import { HandleDiscordMessageUseCase } from "../../../src/application/use-cases/HandleDiscordMessage.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import { MessageIntent } from "../../../src/domain/message/MessageIntent.ts";

const testLogger = pino({ level: "silent" });

const prevAiMessage = new AIMessage("Previous response");

const baseMessage: DiscordMessage = {
    id: "uuid-1",
    discordMessageId: "discord-123",
    repliesToDiscordId: null,
    channelId: "ch-456",
    guildId: "guild-789",
    role: "assistant",
    langchainMessages: [prevAiMessage.toJSON() as unknown as Record<string, unknown>],
    retriesLeft: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
};

const mockAiResponse = new AIMessage("AI response");

function makeRepo(chainMessages: DiscordMessage[] = []): IMessageRepository {
    return {
        save: mock(async () => ({ id: "new-uuid" })),
        saveAssistantMessage: mock(async () => ({ id: "new-uuid" })),
        fetchChain: mock(async () => chainMessages),
        findById: mock(async () => null),
        findByDiscordMessageId: mock(async () => null),
        findExistingDiscordIds: mock(async () => []),
        saveBatch: mock(async (msgs) => msgs.map((_m: DiscordMessage, i: number) => ({ id: `batch-uuid-${i}` }))),
        deleteByDiscordMessageId: mock(async () => {}),
    };
}

function makeChatMessageService(snapshots: DiscordMessageSnapshot[] = []): IChatMessageService {
    return {
        fetchChain: mock(async () => snapshots),
    };
}

function makeOrchestrator(response = "AI response"): IAgentOrchestrator {
    return {
        // Return deserialized messages only when records are present — mirrors real behavior
        buildHistory: mock((records: DiscordMessage[]) => (records.length > 0 ? [prevAiMessage] : [])),
        process: mock(async () => ({
            content: response,
            newMessages: [mockAiResponse],
            isRetryable: false,
            usedFallback: false,
        })),
    };
}

function makeDownloader(): IAttachmentDownloader {
    return {
        download: mock(async (a) => ({
            data: "base64data",
            mimeType: a.contentType ?? "application/octet-stream",
            name: a.name,
        })),
    };
}

const testConfig = {
    maxInlineAttachmentSizeMb: 100,
    attachmentMode: "inline" as const,
};

describe("HandleDiscordMention.handle", () => {
    test("returns the orchestrator response", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator("Hello back!");
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        const result = await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(result.response).toBe("Hello back!");
        expect(result.newMessages).toHaveLength(1);
    });

    test("does not fetch chain when referencedMessageId is null", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "@me",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(repo.fetchChain).not.toHaveBeenCalled();
    });

    test("fetches chain when referencedMessageId is set", async () => {
        const repo = makeRepo([baseMessage]);
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        await handler.handle({
            discordMessageId: "user-msg-2",
            referencedMessageId: "discord-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Follow-up",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(repo.fetchChain).toHaveBeenCalledWith({
            startDiscordMessageId: "discord-123",
            channelId: "ch-1",
            guildId: "guild-1",
        });
    });

    test("passes fetched history to orchestrator as LangChain messages", async () => {
        const repo = makeRepo([baseMessage]);
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        await handler.handle({
            discordMessageId: "user-msg-2",
            referencedMessageId: "discord-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Follow-up",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        const firstCall = (orchestrator.process as ReturnType<typeof mock>).mock.calls[0];
        expect(firstCall).toBeDefined();
        const [history, userMessage] = firstCall as [unknown[], HumanMessage];
        // baseMessage has one serialized AIMessage → deserialized to 1 BaseMessage
        expect(history).toHaveLength(1);
        expect(userMessage).toBeInstanceOf(HumanMessage);
        expect((userMessage as HumanMessage).content).toBe("Follow-up");
    });

    test("forwards onStatusUpdate to orchestrator.process as the third argument", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        const onStatusUpdate: OnStatusUpdate = mock(() => {});

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "@me",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
            onStatusUpdate,
        });

        const firstCall = (orchestrator.process as ReturnType<typeof mock>).mock.calls[0];
        expect(firstCall).toBeDefined();
        // Fourth argument (index 3) must be the exact callback passed in; index 2 is intent
        expect(firstCall?.[3]).toBe(onStatusUpdate);
    });

    test("passes empty history to orchestrator when no reply chain", async () => {
        const repo = makeRepo([]);
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "@me",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        const firstCall = (orchestrator.process as ReturnType<typeof mock>).mock.calls[0];
        expect(firstCall).toBeDefined();
        const [history] = firstCall as [unknown[], HumanMessage];
        expect(history).toHaveLength(0);
    });

    test("saves the user's message as a serialized HumanMessage", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            testConfig,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: "prev-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "What is 2+2?",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        const saveCall = (repo.save as ReturnType<typeof mock>).mock.calls[0]?.[0] as DiscordMessage;
        expect(saveCall.discordMessageId).toBe("user-msg-1");
        expect(saveCall.repliesToDiscordId).toBe("prev-123");
        expect(saveCall.role).toBe("human");
        // langchainMessages should contain a serialized HumanMessage
        expect(saveCall.langchainMessages).toHaveLength(1);
        // Verify the stored JSON preserves the message type and content
        const stored = saveCall.langchainMessages[0];
        expect(stored?.id).toContain("HumanMessage");
        expect((stored?.kwargs as Record<string, unknown>)?.content).toBe("What is 2+2?");
    });

    test("returns error response when attachment total size exceeds limit", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            makeDownloader(),
            testLogger,
            { maxInlineAttachmentSizeMb: 1, attachmentMode: "inline" as const }, // 1 MB limit
        );

        const result = await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "@me",
            userContent: "Here are files",
            attachments: [
                {
                    id: "att-001",
                    url: "https://cdn.discord.com/file1",
                    proxyURL: "https://proxy/file1",
                    name: "big.zip",
                    size: 2 * 1024 * 1024, // 2 MB
                    contentType: "application/zip",
                },
            ],
            intent: MessageIntent.UNKNOWN,
        });

        expect(result.response).toContain("exceeds");
        expect(result.newMessages).toHaveLength(0);
        // Orchestrator should NOT have been called
        expect((orchestrator.process as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    });

    test("downloads attachments and passes multimodal HumanMessage to orchestrator", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const downloader = makeDownloader();
        const handler = new HandleDiscordMessageUseCase(
            repo,
            orchestrator as never,
            downloader,
            testLogger,
            testConfig,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "@me",
            userContent: "What's in this image?",
            attachments: [
                {
                    id: "att-002",
                    url: "https://cdn.discord.com/img.png",
                    proxyURL: "https://proxy/img.png",
                    name: "img.png",
                    size: 512,
                    contentType: "image/png",
                },
            ],
            intent: MessageIntent.UNKNOWN,
        });

        expect(downloader.download).toHaveBeenCalledTimes(1);

        const firstCall = (orchestrator.process as ReturnType<typeof mock>).mock.calls[0];
        const userMessage = firstCall?.[1] as HumanMessage;
        expect(userMessage).toBeInstanceOf(HumanMessage);
        // Should have structured content (array), not a plain string
        expect(Array.isArray(userMessage.content)).toBe(true);
    });

    test("calls chatMessageService.fetchChain when DB chain is empty and referencedMessageId is set", async () => {
        // repo returns empty chain — triggers the live fetch fallback
        const repo = makeRepo([]);
        const chatMessageService = makeChatMessageService([]);
        const handler = new HandleDiscordMessageUseCase(
            repo,
            makeOrchestrator() as never,
            makeDownloader(),
            testLogger,
            testConfig,
            undefined,
            undefined,
            undefined,
            chatMessageService,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: "ref-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(chatMessageService.fetchChain).toHaveBeenCalledWith({
            startDiscordMessageId: "ref-123",
            channelId: "ch-1",
            guildId: "guild-1",
        });
    });

    test("does not call chatMessageService.fetchChain when DB chain is non-empty", async () => {
        const repo = makeRepo([baseMessage]);
        const chatMessageService = makeChatMessageService([]);
        const handler = new HandleDiscordMessageUseCase(
            repo,
            makeOrchestrator() as never,
            makeDownloader(),
            testLogger,
            testConfig,
            undefined,
            undefined,
            undefined,
            chatMessageService,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: "discord-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(chatMessageService.fetchChain).not.toHaveBeenCalled();
    });

    test("does not call chatMessageService.fetchChain when referencedMessageId is null", async () => {
        const repo = makeRepo([]);
        const chatMessageService = makeChatMessageService([]);
        const handler = new HandleDiscordMessageUseCase(
            repo,
            makeOrchestrator() as never,
            makeDownloader(),
            testLogger,
            testConfig,
            undefined,
            undefined,
            undefined,
            chatMessageService,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "@me",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(chatMessageService.fetchChain).not.toHaveBeenCalled();
    });

    test("calls saveBatch with only new snapshots when some IDs already exist in DB", async () => {
        const existingSnapshot: DiscordMessageSnapshot = {
            id: "snap-existing",
            content: "old message",
            authorId: "user-1",
            authorUsername: "user1",
            authorDisplayName: "User One",
            isBot: false,
            isOwnBot: false,
            attachments: [],
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "guild-1",
            createdAt: new Date(),
        };
        const newSnapshot: DiscordMessageSnapshot = {
            id: "snap-new",
            content: "new message",
            authorId: "user-2",
            authorUsername: "user2",
            authorDisplayName: "User Two",
            isBot: false,
            isOwnBot: false,
            attachments: [],
            referencedMessageId: "snap-existing",
            channelId: "ch-1",
            guildId: "guild-1",
            createdAt: new Date(),
        };

        // repo returns empty initial chain (triggers fallback), then non-empty after batch save
        const repo = makeRepo([]);
        // findExistingDiscordIds returns "snap-existing" as already in DB
        (repo.findExistingDiscordIds as ReturnType<typeof mock>).mockImplementation(async () => ["snap-existing"]);
        // fetchChain returns populated chain after batch save
        (repo.fetchChain as ReturnType<typeof mock>)
            .mockImplementationOnce(async () => [])
            .mockImplementation(async () => [baseMessage]);

        const chatMessageService = makeChatMessageService([existingSnapshot, newSnapshot]);

        const handler = new HandleDiscordMessageUseCase(
            repo,
            makeOrchestrator() as never,
            makeDownloader(),
            testLogger,
            testConfig,
            undefined,
            undefined,
            undefined,
            chatMessageService,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: "snap-new",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        // saveBatch should only be called with the new snapshot, not the existing one
        const batchCall = (repo.saveBatch as ReturnType<typeof mock>).mock.calls[0]?.[0] as DiscordMessage[];
        expect(batchCall).toHaveLength(1);
        expect(batchCall[0]?.discordMessageId).toBe("snap-new");
    });

    test("returns retryable error response when live chain fetch throws", async () => {
        const repo = makeRepo([]);
        const chatMessageService: IChatMessageService = {
            fetchChain: mock(async () => {
                throw new Error("Discord API down");
            }),
        };

        const handler = new HandleDiscordMessageUseCase(
            repo,
            makeOrchestrator() as never,
            makeDownloader(),
            testLogger,
            testConfig,
            undefined,
            undefined,
            undefined,
            chatMessageService,
        );

        const result = await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: "ref-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Hello",
            attachments: [],
            intent: MessageIntent.UNKNOWN,
        });

        expect(result.isFailure).toBe(true);
        expect(result.isRetryable).toBe(true);
        expect(result.response).toContain("error");
    });
});
