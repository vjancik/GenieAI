import { describe, expect, it, mock } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import pino from "pino";
import { SearchMode } from "../../../src/application/config/AppConfig.ts";
import type {
    IChatClientBot,
    IChatClientMessage,
    IChatClientMessageAttachment,
} from "../../../src/application/ports/chat/IChatClient.ts";
import type { IAgentOrchestrator } from "../../../src/application/ports/IAgentOrchestrator.ts";
import type { IAttachmentDownloader } from "../../../src/application/ports/IAttachmentDownloader.ts";
import type { StatusMessageUpdater } from "../../../src/application/services/StatusMessageUpdater.ts";
import { AgentStatusType } from "../../../src/application/types/AgentStatus.ts";
import { HandleChatMessageUseCase } from "../../../src/application/use-cases/HandleChatMessage.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";
import { MessageIntent } from "../../../src/domain/message/MessageIntent.ts";
import type { IMessagePageRepository } from "../../../src/domain/message/MessagePage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: "silent" });

const BOT_USER_ID = "bot-1";
const CHANNEL_ID = "ch-1";
const GUILD_ID = "guild-1";

function makeAttachment(id = "att-1"): IChatClientMessageAttachment {
    return {
        id,
        url: `https://cdn/${id}`,
        proxyURL: `https://proxy/${id}`,
        name: `${id}.png`,
        size: 128,
        contentType: "image/png",
    };
}

function makeMessage(overrides: Partial<IChatClientMessage> & { id: string }): IChatClientMessage {
    const defaultReply = mock(async () => makeMessage({ id: `${overrides.id}-reply` }));
    const base: Partial<IChatClientMessage> = {
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        authorId: "user-1",
        content: "",
        isAuthorBot: false,
        attachments: [],
        embeds: [],
        referencedMessageId: null,
        botRoleId: null,
        hasExplicitMention: () => false,
        reply: defaultReply,
        edit: mock(async () => makeMessage({ id: overrides.id })),
    };
    return { ...base, ...overrides } as unknown as IChatClientMessage;
}

function makeBot(userId = BOT_USER_ID): IChatClientBot {
    return { userId } as IChatClientBot;
}

function makeMessageRepo(overrides: Partial<IMessageRepository> = {}): IMessageRepository {
    return {
        save: mock(async () => ({ id: "row-1" })),
        saveAssistantMessage: mock(async () => ({ id: "row-1" })),
        fetchChain: mock(async () => []),
        findExistingDiscordIds: mock(async () => []),
        ...overrides,
    } as unknown as IMessageRepository;
}

function makePageRepo(): IMessagePageRepository {
    return {
        save: mock(async () => {}),
    } as unknown as IMessagePageRepository;
}

function makeOrchestrator(
    overrides: Partial<{
        response: string;
        isRetryable: boolean;
        usedFallback: boolean;
        throws: boolean;
    }> = {},
): IAgentOrchestrator {
    return {
        buildHistory: mock(() => []),
        process: mock(async (_history, _intent, onStatusUpdate) => {
            if (overrides.throws) throw new Error("orchestrator exploded");
            onStatusUpdate?.({ type: AgentStatusType.SEARCHING });
            return {
                content: overrides.response ?? "AI response",
                newMessages: [] as BaseMessage[],
                isRetryable: overrides.isRetryable ?? false,
                usedFallback: overrides.usedFallback ?? false,
            };
        }),
    } as unknown as IAgentOrchestrator;
}

function makeAttachmentDownloader(): IAttachmentDownloader {
    return {
        download: mock(async () => ({ name: "file.png", mimeType: "image/png", data: "base64data" })),
    } as unknown as IAttachmentDownloader;
}

function makeStatusUpdater(): StatusMessageUpdater {
    return {
        scheduleUpdate: mock(() => {}),
        cancel: mock(() => {}),
    } as unknown as StatusMessageUpdater;
}

function makeUseCase(
    overrides: {
        orchestrator?: IAgentOrchestrator;
        messageRepo?: IMessageRepository;
        messagePageRepo?: IMessagePageRepository;
        statusUpdater?: StatusMessageUpdater;
        bot?: IChatClientBot;
        previousBotId?: string;
        defaultRetriesLeft?: number;
        searchMode?: SearchMode;
        attachmentDownloader?: IAttachmentDownloader;
    } = {},
): HandleChatMessageUseCase {
    return new HandleChatMessageUseCase(
        overrides.orchestrator ?? makeOrchestrator(),
        overrides.messageRepo ?? makeMessageRepo(),
        overrides.statusUpdater ?? makeStatusUpdater(),
        logger,
        overrides.bot ?? makeBot(),
        overrides.previousBotId,
        overrides.messagePageRepo ?? makePageRepo(),
        overrides.defaultRetriesLeft ?? 0,
        overrides.searchMode ?? SearchMode.tavily,
        overrides.attachmentDownloader ?? makeAttachmentDownloader(),
        // Minimal config stub — inline mode; limit set high so test attachments are never rejected
        {
            file: {
                agent: { maxInlineAttachmentSizeBytes: 10 * 1024 * 1024, uploadAttachmentMode: "inline" },
                attachmentDownloader: { tempDir: "/tmp" },
            },
        } as never,
    );
}

// ---------------------------------------------------------------------------
// execute — bot/intent guards, shutdown, rate limit, content extraction
// ---------------------------------------------------------------------------

describe("HandleChatMessageUseCase.execute", () => {
    it("ignores bot-authored messages", async () => {
        const orchestrator = makeOrchestrator();
        const useCase = makeUseCase({ orchestrator });
        const msg = makeMessage({ id: "msg-1", isAuthorBot: true });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        expect(msg.reply).not.toHaveBeenCalled();
        expect(orchestrator.process).not.toHaveBeenCalled();
    });

    it("ignores UNKNOWN intent with no explicit mention", async () => {
        const orchestrator = makeOrchestrator();
        const useCase = makeUseCase({ orchestrator });
        const msg = makeMessage({ id: "msg-1", content: "just a normal message" });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        expect(msg.reply).not.toHaveBeenCalled();
        expect(orchestrator.process).not.toHaveBeenCalled();
    });

    it("proceeds when UNKNOWN intent but has explicit mention", async () => {
        const orchestrator = makeOrchestrator();
        const useCase = makeUseCase({ orchestrator });
        const msg = makeMessage({ id: "msg-1", content: "hey", hasExplicitMention: () => true });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        expect(orchestrator.process).toHaveBeenCalled();
    });

    it("sends restart notice and saves to DB when shutdown is pending", async () => {
        const messageRepo = makeMessageRepo();
        const useCase = makeUseCase({ messageRepo });
        const msg = makeMessage({ id: "msg-1", content: "!ai hello" });

        await useCase.execute({ message: msg, shutdownPending: true, isRateLimited: false });

        expect(messageRepo.saveAssistantMessage).toHaveBeenCalled();
        expect(msg.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("restart") }),
        );
    });

    it("sends rate limit reply and saves to DB when rate limited", async () => {
        const messageRepo = makeMessageRepo();
        const useCase = makeUseCase({ messageRepo });
        const msg = makeMessage({ id: "msg-1", content: "!ai hello" });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: true });

        expect(msg.reply).toHaveBeenCalled();
        expect(messageRepo.saveAssistantMessage).toHaveBeenCalled();
    });

    it("injects synthetic greeting when content is empty, no attachments, and no reply reference", async () => {
        const orchestrator = makeOrchestrator();
        const useCase = makeUseCase({ orchestrator });
        const msg = makeMessage({
            id: "msg-1",
            content: `<@${BOT_USER_ID}>`,
            attachments: [],
            referencedMessageId: null,
            hasExplicitMention: () => true,
        });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        // The orchestrator should receive history with a human message containing "introduce yourself"
        const processCall = (orchestrator.process as ReturnType<typeof mock>).mock.calls[0];
        const history = processCall?.[0] as BaseMessage[];
        const lastMsg = history?.at(-1);
        expect(lastMsg?.content).toContain("introduce yourself");
    });

    it("extracts attachments and passes them to the orchestrator; no greeting when attachments present", async () => {
        const orchestrator = makeOrchestrator();
        const useCase = makeUseCase({ orchestrator });
        const msg = makeMessage({
            id: "msg-1",
            content: `<@${BOT_USER_ID}>`,
            attachments: [makeAttachment("att-1")],
            referencedMessageId: null,
            hasExplicitMention: () => true,
        });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        // orchestrator.process is called — attachment handling didn't prevent it
        expect(orchestrator.process).toHaveBeenCalled();
        const processCall = (orchestrator.process as ReturnType<typeof mock>).mock.calls[0];
        const history = processCall?.[0] as BaseMessage[];
        const lastMsg = history?.at(-1);
        expect(String(lastMsg?.content ?? "")).not.toContain("introduce yourself");
    });
});

// ---------------------------------------------------------------------------
// invokeAgent — thinking placeholder, error recovery, onStatusUpdate
// ---------------------------------------------------------------------------

describe("HandleChatMessageUseCase.invokeAgent", () => {
    it("returns isFailure=true and thinking placeholder promise when orchestrator throws", async () => {
        const orchestrator = makeOrchestrator({ throws: true });
        const messageRepo = makeMessageRepo();
        const useCase = makeUseCase({ orchestrator, messageRepo });

        const thinkingMsg = makeMessage({ id: "thinking-1", authorId: BOT_USER_ID, isAuthorBot: true });
        const msg = makeMessage({
            id: "user-msg-1",
            content: "!ai hello",
            reply: mock(async () => thinkingMsg),
        });

        const result = await useCase.invokeAgent({
            message: msg,
            userContent: "hello",
            attachments: [],
            intent: MessageIntent.GENERAL,
        });

        // processMessage catches the orchestrator throw internally and returns isFailure: true.
        // The thinking placeholder promise is always returned so the caller can clean it up.
        expect(result.isFailure).toBe(true);
        expect(result.thinkingMessagePromise).toBeDefined();
    });

    it("calls statusUpdater.scheduleUpdate when onStatusUpdate is invoked", async () => {
        const statusUpdater = makeStatusUpdater();
        const orchestrator = makeOrchestrator();
        const useCase = makeUseCase({ orchestrator, statusUpdater });

        const thinkingMsg = makeMessage({ id: "thinking-2", authorId: BOT_USER_ID, isAuthorBot: true });
        let thinkingResolved!: () => void;
        const thinkingSettled = new Promise<void>((res) => {
            thinkingResolved = res;
        });

        const msg = makeMessage({
            id: "user-msg-2",
            content: "!ai hello",
            reply: mock(async () => {
                thinkingResolved();
                return thinkingMsg;
            }),
        });

        await useCase.invokeAgent({
            message: msg,
            userContent: "hello",
            attachments: [],
            intent: MessageIntent.GENERAL,
        });

        await thinkingSettled;
        await Promise.resolve();

        expect(statusUpdater.scheduleUpdate).toHaveBeenCalled();
    });
});
