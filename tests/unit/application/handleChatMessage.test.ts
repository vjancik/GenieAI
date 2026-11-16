import { describe, expect, it, mock, spyOn } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import pino from "pino";
import {
    FALLBACK_FOOTER,
    finishReasonFooter,
    INTERRUPTED_FOOTER,
} from "../../../src/application/formatters/responseFooters.ts";
import type {
    IChatClientBot,
    IChatClientMessage,
    IChatClientMessageAttachment,
} from "../../../src/application/ports/chat/IChatClient.ts";
import type { IAgentOrchestrator } from "../../../src/application/ports/IAgentOrchestrator.ts";
import type { StatusMessageUpdater } from "../../../src/application/services/StatusMessageUpdater.ts";
import { AgentStatusType } from "../../../src/application/types/AgentStatus.ts";
import type { Logger } from "../../../src/application/types/Logger.ts";
import { HandleChatMessageUseCase } from "../../../src/application/use-cases/HandleChatMessage.ts";
import {
    ModelOverloadedError,
    ModelPromptBlockedError,
    ModelTimeoutError,
} from "../../../src/domain/errors/AppError.ts";
import type { IMessagePageRepository } from "../../../src/domain/ports/IMessagePageRepository.ts";
import type { IMessageRepository } from "../../../src/domain/ports/IMessageRepository.ts";
import { BlockReason } from "../../../src/domain/value-objects/BlockReason.ts";
import { FinishReason } from "../../../src/domain/value-objects/FinishReason.ts";
import { MessageIntent } from "../../../src/domain/value-objects/MessageIntent.ts";

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
        saveBotMessage: mock(async () => ({ id: "row-1" })),
        saveBotPlaceholderMessage: mock(async () => ({ id: "row-1" })),
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
        usedRetryableFallback: boolean;
        wasInterrupted: boolean;
        finishReason: FinishReason | null;
        throws: boolean;
        /** Error thrown when `throws` is set; defaults to a generic Error. */
        error: unknown;
    }> = {},
): IAgentOrchestrator {
    return {
        buildHistory: mock(() => []),
        process: mock(async (_history, _intent, onStatusUpdate) => {
            if (overrides.throws) throw overrides.error ?? new Error("orchestrator exploded");
            onStatusUpdate?.({ type: AgentStatusType.SEARCHING });
            return {
                content: overrides.response ?? "AI response",
                newMessages: [] as BaseMessage[],
                isRetryable: overrides.isRetryable ?? false,
                usedFallback: overrides.usedFallback ?? false,
                usedRetryableFallback: overrides.usedRetryableFallback ?? false,
                wasInterrupted: overrides.wasInterrupted ?? false,
                finishReason: overrides.finishReason ?? null,
            };
        }),
    } as unknown as IAgentOrchestrator;
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
        retries?: number;
        logger?: Logger;
    } = {},
): HandleChatMessageUseCase {
    return new HandleChatMessageUseCase(
        overrides.orchestrator ?? makeOrchestrator(),
        overrides.messageRepo ?? makeMessageRepo(),
        overrides.statusUpdater ?? makeStatusUpdater(),
        overrides.logger ?? logger,
        overrides.bot ?? makeBot(),
        overrides.previousBotId,
        overrides.messagePageRepo ?? makePageRepo(),
        overrides.retries ?? 0,
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

        expect(messageRepo.saveBotPlaceholderMessage).toHaveBeenCalled();
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
        expect(messageRepo.saveBotPlaceholderMessage).toHaveBeenCalled();
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

    it("returns isFailure=true and empty response when processMessage returns a failure", async () => {
        // processMessage catches orchestrator errors internally and surfaces them as isFailure=true.
        // invokeAgent propagates that result unchanged.
        const orchestrator = makeOrchestrator({ throws: true });
        const messageRepo = makeMessageRepo();
        const useCase = makeUseCase({ orchestrator, messageRepo });

        const thinkingMsg = makeMessage({ id: "thinking-err", authorId: BOT_USER_ID, isAuthorBot: true });
        const msg = makeMessage({
            id: "user-msg-err",
            content: "!ai hello",
            reply: mock(async () => thinkingMsg),
        });

        const result = await useCase.invokeAgent({
            message: msg,
            userContent: "hello",
            attachments: [],
            intent: MessageIntent.GENERAL,
        });

        expect(result.isFailure).toBe(true);
        // isRetryable is true when processMessage catches an error (allows retry button)
        expect(result.isRetryable).toBe(true);
        expect(result.thinkingMessagePromise).toBeDefined();
    });

    it.each([
        ["an AppError with a displayMessage", new ModelOverloadedError(new Error("503")), ModelOverloadedError],
        [
            "a model AppError wrapped in another error's cause",
            new Error("graph failed", { cause: new ModelTimeoutError() }),
            ModelTimeoutError,
        ],
    ] as const)("surfaces the display message when the orchestrator throws %s", async (_label, error, ErrorClass) => {
        const useCase = makeUseCase({ orchestrator: makeOrchestrator({ throws: true, error }) });
        const msg = makeMessage({
            id: "user-msg-display",
            content: "!ai hello",
            reply: mock(async () => makeMessage({ id: "thinking-display" })),
        });

        const result = await useCase.invokeAgent({
            message: msg,
            userContent: "hello",
            attachments: [],
            intent: MessageIntent.GENERAL,
        });

        expect(result.response).toBe(new ErrorClass().displayMessage ?? "");
        expect(result.isFailure).toBe(true);
        expect(result.isRetryable).toBe(true);
    });

    it("falls back to the generic error message when the error carries no display message", async () => {
        const useCase = makeUseCase({ orchestrator: makeOrchestrator({ throws: true }) });
        const msg = makeMessage({
            id: "user-msg-generic",
            content: "!ai hello",
            reply: mock(async () => makeMessage({ id: "thinking-generic" })),
        });

        const result = await useCase.invokeAgent({
            message: msg,
            userContent: "hello",
            attachments: [],
            intent: MessageIntent.GENERAL,
        });

        expect(result.response).toBe("Sorry, I encountered an error processing your request.");
    });
});

// ---------------------------------------------------------------------------
// Blocked prompts — non-retryable, logged as warnings only
// ---------------------------------------------------------------------------

describe("HandleChatMessageUseCase — blocked prompts", () => {
    /** Runs execute() with an orchestrator throwing `error`; returns the final reply and the logger spies. */
    async function sendFailing(error: unknown) {
        const spiedLogger = pino({ level: "silent" });
        const warn = spyOn(spiedLogger, "warn");
        const errorLog = spyOn(spiedLogger, "error");
        const useCase = makeUseCase({
            orchestrator: makeOrchestrator({ throws: true, error }),
            logger: spiedLogger,
            retries: 1,
        });
        const thinkingMsg = makeMessage({ id: "thinking", authorId: BOT_USER_ID, isAuthorBot: true });
        const msg = makeMessage({ id: "user-msg", content: "!ai hello", reply: mock(async () => thinkingMsg) });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        const reply = (msg.reply as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
            content: string;
            buttons?: { label: string }[];
        };
        return { reply, warn, errorLog };
    }

    it("shows the block explanation without offering a retry", async () => {
        const blocked = new ModelPromptBlockedError(BlockReason.SAFETY);

        const { reply } = await sendFailing(blocked);

        expect(reply.content).toBe(blocked.displayMessage ?? "");
        expect(reply.buttons?.some((b) => b.label.startsWith("Retry")) ?? false).toBe(false);
    });

    it("logs a blocked prompt as a warning rather than an error", async () => {
        const { warn, errorLog } = await sendFailing(new ModelPromptBlockedError(BlockReason.SAFETY));

        expect(warn).toHaveBeenCalledWith(expect.anything(), "Failed to process message");
        expect(errorLog).not.toHaveBeenCalledWith(expect.anything(), "Failed to process message");
    });

    it("still logs other failures as errors and offers a retry", async () => {
        const { reply, warn, errorLog } = await sendFailing(new ModelOverloadedError());

        expect(errorLog).toHaveBeenCalledWith(expect.anything(), "Failed to process message");
        expect(warn).not.toHaveBeenCalledWith(expect.anything(), "Failed to process message");
        expect(reply.buttons?.some((b) => b.label.startsWith("Retry"))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Response footers — fallback, interruption, and finish reason precedence
// ---------------------------------------------------------------------------

describe("HandleChatMessageUseCase — response footers", () => {
    /**
     * Runs execute() and returns the content of the final bot reply. `msg.reply` serves
     * both the thinking placeholder and the answer, so the answer is the last call.
     */
    async function sendAndGetReplyContent(orchestrator: IAgentOrchestrator): Promise<string> {
        const useCase = makeUseCase({ orchestrator });
        const thinkingMsg = makeMessage({ id: "thinking", authorId: BOT_USER_ID, isAuthorBot: true });
        const msg = makeMessage({
            id: "user-msg",
            content: "!ai hello",
            reply: mock(async () => thinkingMsg),
        });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        const calls = (msg.reply as ReturnType<typeof mock>).mock.calls;
        const lastCall = calls.at(-1)?.[0] as { content: string } | undefined;
        return lastCall?.content ?? "";
    }

    it("appends no footer on a clean response", async () => {
        const content = await sendAndGetReplyContent(makeOrchestrator({ response: "clean answer" }));

        expect(content).toBe("clean answer");
    });

    it("explains a degraded finish reason", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({ response: "partial answer", finishReason: FinishReason.SAFETY }),
        );

        expect(content).toContain("partial answer");
        expect(content).toContain(finishReasonFooter(FinishReason.SAFETY));
    });

    it("falls back to the generic notice when the stream ended with no reason", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({ response: "partial answer", wasInterrupted: true }),
        );

        expect(content).toContain(INTERRUPTED_FOOTER);
    });

    // The two signals are mutually exclusive per invocation, but each is sticky across
    // graph nodes, so both can arrive together. The specific reason must win outright.
    it("shows only the finish reason footer when interruption is also flagged", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({
                response: "partial answer",
                wasInterrupted: true,
                finishReason: FinishReason.SAFETY,
            }),
        );

        expect(content).toContain(finishReasonFooter(FinishReason.SAFETY));
        expect(content).not.toContain(INTERRUPTED_FOOTER);
    });

    // The fallback notice describes which model answered, not how generation ended,
    // so it is orthogonal and may accompany a truncation footer.
    it("shows the fallback notice alongside a finish reason footer", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({
                response: "partial answer",
                isRetryable: true,
                usedFallback: true,
                usedRetryableFallback: true,
                finishReason: FinishReason.MAX_TOKENS,
            }),
        );

        expect(content).toContain(FALLBACK_FOOTER);
        expect(content).toContain(finishReasonFooter(FinishReason.MAX_TOKENS));
        expect(content).not.toContain(INTERRUPTED_FOOTER);
    });

    it("shows the fallback notice when the fallback is a reason to retry", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({
                response: "fallback answer",
                isRetryable: true,
                usedFallback: true,
                usedRetryableFallback: true,
            }),
        );

        expect(content).toBe(`fallback answer${FALLBACK_FOOTER}`);
    });

    // A non-retryable fallback is configured as an equal alternative, so there is nothing
    // to explain and no Retry button to point at.
    it("omits the fallback notice when the fallback is not retryable", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({ response: "fallback answer", usedFallback: true, usedRetryableFallback: false }),
        );

        expect(content).toBe("fallback answer");
    });

    // The response is retryable because of the interruption, not the fallback, so only the
    // interruption notice applies — the fallback notice would misstate why Retry is offered.
    it("omits the fallback notice when only an interruption made a fallback response retryable", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({
                response: "partial answer",
                isRetryable: true,
                usedFallback: true,
                usedRetryableFallback: false,
                wasInterrupted: true,
            }),
        );

        expect(content).toBe(`partial answer${INTERRUPTED_FOOTER}`);
    });

    it("appends no footer for a reported clean stop", async () => {
        const content = await sendAndGetReplyContent(
            makeOrchestrator({ response: "clean answer", finishReason: FinishReason.STOP }),
        );

        expect(content).toBe("clean answer");
    });
});

// ---------------------------------------------------------------------------
// Empty responses — display-only notice plus the footer explaining why
// ---------------------------------------------------------------------------

describe("HandleChatMessageUseCase — empty responses", () => {
    const EMPTY_NOTICE = "The AI model returned an empty response.";

    /** Runs execute() with an orchestrator returning no content; returns the reply and the persisted bot row. */
    async function sendEmpty(overrides: Parameters<typeof makeOrchestrator>[0] = {}) {
        const messageRepo = makeMessageRepo();
        const useCase = makeUseCase({
            orchestrator: makeOrchestrator({ response: "", ...overrides }),
            messageRepo,
            retries: 1,
        });
        const thinkingMsg = makeMessage({ id: "thinking", authorId: BOT_USER_ID, isAuthorBot: true });
        const msg = makeMessage({ id: "user-msg", content: "!ai hello", reply: mock(async () => thinkingMsg) });

        await useCase.execute({ message: msg, shutdownPending: false, isRateLimited: false });

        const reply = (msg.reply as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
            content: string;
            buttons?: { label: string }[];
        };
        const saved = (messageRepo.saveBotMessage as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
            usedFallback: boolean;
        };
        return { reply, saved };
    }

    it("shows the notice with its own retry advice when nothing else explains the empty response", async () => {
        const { reply } = await sendEmpty();

        expect(reply.content).toBe(
            `${EMPTY_NOTICE} A retry usually fixes this unless the provider servers are temporarily overloaded.`,
        );
    });

    it("shows the short notice followed by the finish reason footer", async () => {
        const { reply } = await sendEmpty({ finishReason: FinishReason.SAFETY });

        expect(reply.content).toBe(EMPTY_NOTICE + finishReasonFooter(FinishReason.SAFETY));
    });

    it("shows the short notice followed by the interruption footer", async () => {
        const { reply } = await sendEmpty({ wasInterrupted: true });

        expect(reply.content).toBe(EMPTY_NOTICE + INTERRUPTED_FOOTER);
    });

    it("shows the short notice followed by the fallback footer and keeps the fallback flag", async () => {
        const { reply, saved } = await sendEmpty({ usedFallback: true, usedRetryableFallback: true });

        expect(reply.content).toBe(EMPTY_NOTICE + FALLBACK_FOOTER);
        expect(saved.usedFallback).toBe(true);
    });

    it("offers a retry", async () => {
        const { reply } = await sendEmpty();

        expect(reply.buttons?.some((b) => b.label.startsWith("Retry"))).toBe(true);
    });
});
