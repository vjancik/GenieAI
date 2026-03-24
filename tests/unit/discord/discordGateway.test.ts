import { describe, expect, it, mock, spyOn } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import pino from "pino";
import type { IChatClientButtonInteraction } from "../../../src/application/ports/chat/IChatClientButtonInteraction.ts";
import type { IChatClientChannel } from "../../../src/application/ports/chat/IChatClientChannel.ts";
import type { IChatClientContextMenuInteraction } from "../../../src/application/ports/chat/IChatClientContextMenuInteraction.ts";
import type {
    IChatClientMessage,
    IChatClientMessageAttachment,
} from "../../../src/application/ports/chat/IChatClientMessage.ts";
import { AgentStatusType } from "../../../src/application/types/AgentStatus.ts";
import type { GetNextPageResult, GetNextPageUseCase } from "../../../src/application/use-cases/GetNextPage.ts";
import type { HandleDiscordMessageUseCase } from "../../../src/application/use-cases/HandleDiscordMessage.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";
import type { IMessagePageRepository } from "../../../src/domain/message/MessagePage.ts";
import type { DiscordClient } from "../../../src/infrastructure/discord/DiscordClient.ts";
import { DiscordGateway } from "../../../src/infrastructure/discord/DiscordGateway.ts";
import { RateLimiter } from "../../../src/infrastructure/discord/RateLimiter.ts";
import type { StatusMessageUpdater } from "../../../src/infrastructure/discord/StatusMessageUpdater.ts";
import type { HtmlToImageRenderer } from "../../../src/infrastructure/exporters/HtmlToImageRenderer.ts";
import type { MarkdownToHtmlRenderer } from "../../../src/infrastructure/exporters/MarkdownToHtmlRenderer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: "silent" });

const BASE_DATE = new Date("2024-06-01T12:00:00Z");
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

/**
 * Builds a minimal IChatClientMessage mock.
 * `reply` returns a new stub message by default; override as needed.
 */
function makeMessage(overrides: Partial<IChatClientMessage> & { id: string }): IChatClientMessage {
    const sent: IChatClientMessage = {
        id: `reply-to-${overrides.id}`,
        channelId: overrides.channelId ?? CHANNEL_ID,
        guildId: overrides.guildId !== undefined ? overrides.guildId : GUILD_ID,
        authorId: "reply-author",
        authorUsername: "bot",
        authorDisplayName: "Bot",
        isAuthorBot: true,
        createdAt: BASE_DATE,
        content: "reply",
        cleanContent: "reply",
        buttons: [],
        attachments: [],
        embeds: [],
        referencedMessageId: overrides.id,
        isForwarded: false,
        forwardedSnapshot: null,
        botRoleId: null,
        hasExplicitMention: () => false,
        reply: mock(async () => sent),
        edit: mock(async () => sent),
        delete: mock(async () => {}),
    };

    return {
        id: overrides.id,
        channelId: overrides.channelId ?? CHANNEL_ID,
        guildId: overrides.guildId !== undefined ? overrides.guildId : GUILD_ID,
        authorId: overrides.authorId ?? "user-1",
        authorUsername: overrides.authorUsername ?? "alice",
        authorDisplayName: overrides.authorDisplayName ?? "Alice",
        isAuthorBot: overrides.isAuthorBot ?? false,
        createdAt: overrides.createdAt ?? BASE_DATE,
        content: overrides.content ?? "hello",
        cleanContent: overrides.cleanContent ?? "hello",
        buttons: overrides.buttons ?? [],
        attachments: overrides.attachments ?? [],
        embeds: overrides.embeds ?? [],
        referencedMessageId: overrides.referencedMessageId !== undefined ? overrides.referencedMessageId : null,
        isForwarded: overrides.isForwarded ?? false,
        forwardedSnapshot: overrides.forwardedSnapshot ?? null,
        botRoleId: overrides.botRoleId ?? null,
        hasExplicitMention: overrides.hasExplicitMention ?? (() => false),
        reply: overrides.reply ?? mock(async () => sent),
        edit: overrides.edit ?? mock(async () => sent),
        delete: overrides.delete ?? mock(async () => {}),
    };
}

/** Builds a minimal button interaction mock. */
function makeButtonInteraction(overrides: {
    messageId?: string;
    messageContent?: string;
    referencedMessageId?: string | null;
    messageButtons?: IChatClientMessage["buttons"];
    customId?: string;
    userId?: string;
    channel?: IChatClientChannel | null;
}): IChatClientButtonInteraction {
    const msg = makeMessage({
        id: overrides.messageId ?? "bot-msg-1",
        content: overrides.messageContent ?? "bot response",
        authorId: BOT_USER_ID,
        isAuthorBot: true,
        referencedMessageId: overrides.referencedMessageId ?? null,
        buttons: overrides.messageButtons ?? [],
    });

    return {
        message: msg,
        channel: overrides.channel !== undefined ? overrides.channel : null,
        customId: overrides.customId ?? "retry_mention",
        userId: overrides.userId ?? "user-1",
        deferUpdate: mock(async () => {}),
        reply: mock(async () => {}),
        followUp: mock(async () => {}),
    };
}

/** Builds a minimal context menu interaction mock. */
function makeContextMenuInteraction(overrides: {
    targetMessageId?: string;
    targetAuthorId?: string;
    targetContent?: string;
    userId?: string;
}): IChatClientContextMenuInteraction {
    const targetContent = overrides.targetContent ?? "some content";
    const target = makeMessage({
        id: overrides.targetMessageId ?? "target-msg-1",
        authorId: overrides.targetAuthorId ?? "user-1",
        content: targetContent,
        cleanContent: targetContent,
    });

    return {
        targetMessage: target,
        userId: overrides.userId ?? "invoker-1",
        reply: mock(async () => {}),
        deferReply: mock(async () => {}),
        editReply: mock(async () => {}),
        deleteReply: mock(async () => {}),
    };
}

/** Builds a stub DiscordClient that exposes a bot user. */
function makeDiscordClient(userId = BOT_USER_ID): DiscordClient {
    return {
        client: { user: { id: userId }, on: () => {} },
    } as unknown as DiscordClient;
}

/** Builds a stub IMessageRepository — all methods return sensible defaults. */
function makeMessageRepo(overrides: Partial<IMessageRepository> = {}): IMessageRepository {
    return {
        save: mock(async () => ({ id: "row-uuid-1" })),
        fetchChain: mock(async () => []),
        saveAssistantMessage: mock(async () => ({ id: "row-uuid-1" })),
        findById: mock(async () => null),
        findByDiscordMessageId: mock(async () => null),
        findExistingDiscordIds: mock(async () => []),
        existsByDiscordMessageId: mock(async () => false),
        deleteByDiscordMessageId: mock(async () => {}),
        saveBatch: mock(async () => []),
        ...overrides,
    };
}

/** Builds a stub IMessagePageRepository. */
function makePageRepo(): IMessagePageRepository {
    return {
        save: mock(async (p) => ({ ...p, id: "page-uuid-1", createdAt: BASE_DATE })),
    };
}

/** Builds a stub HandleDiscordMessageUseCase that resolves immediately. */
function makeUseCase(
    overrides: Partial<{ response: string; isFailure: boolean; isRetryable: boolean; usedFallback: boolean }> = {},
): HandleDiscordMessageUseCase {
    return {
        execute: mock(async () => ({
            response: overrides.response ?? "AI response",
            newMessages: [] as BaseMessage[],
            isFailure: overrides.isFailure ?? false,
            isRetryable: overrides.isRetryable ?? false,
            usedFallback: overrides.usedFallback ?? false,
        })),
    } as unknown as HandleDiscordMessageUseCase;
}

/** Builds a stub GetNextPageUseCase. */
function makeGetNextPageUseCase(result: GetNextPageResult | null = null): GetNextPageUseCase {
    return { execute: mock(async () => result) } as unknown as GetNextPageUseCase;
}

/** Builds a stub StatusMessageUpdater. */
function makeStatusUpdater(): StatusMessageUpdater {
    return {
        scheduleUpdate: mock(() => {}),
        cancel: mock(() => {}),
    } as unknown as StatusMessageUpdater;
}

/** Builds a stub MarkdownToHtmlRenderer. */
function makeMarkdownToHtml(html = "<p>html</p>"): MarkdownToHtmlRenderer {
    return { render: mock(() => html) } as unknown as MarkdownToHtmlRenderer;
}

/** Builds a stub HtmlToImageRenderer. */
function makeHtmlToImage(png = Buffer.from("PNG")): HtmlToImageRenderer {
    return { render: mock(async () => png) } as unknown as HtmlToImageRenderer;
}

/** Constructs a DiscordGateway with all dependencies stubbed. */
function makeGateway(
    overrides: {
        useCase?: HandleDiscordMessageUseCase;
        messageRepo?: IMessageRepository;
        pageRepo?: IMessagePageRepository;
        getNextPage?: GetNextPageUseCase;
        statusUpdater?: StatusMessageUpdater;
        markdownToHtml?: MarkdownToHtmlRenderer;
        htmlToImage?: HtmlToImageRenderer;
        rateLimiter?: RateLimiter;
        previousBotId?: string;
        searchMode?: string;
    } = {},
): DiscordGateway {
    const discordClient = makeDiscordClient();
    // Prevent registerEventHandlers from crashing — the raw client.on is a no-op stub
    (discordClient.client as unknown as Record<string, unknown>).on = () => {};

    return new DiscordGateway(
        discordClient,
        overrides.useCase ?? makeUseCase(),
        logger,
        overrides.statusUpdater ?? makeStatusUpdater(),
        overrides.pageRepo ?? makePageRepo(),
        overrides.getNextPage ?? makeGetNextPageUseCase(),
        overrides.messageRepo ?? makeMessageRepo(),
        {
            discord: { defaultChainLimit: 10, defaultRetriesLeft: 3, previousBotId: overrides.previousBotId },
            agent: { nodes: { search: { mode: overrides.searchMode ?? "none" } } },
        } as unknown as Pick<import("../../../src/application/config/AppConfig.ts").FileConfig, "discord" | "agent">,
        overrides.markdownToHtml ?? makeMarkdownToHtml(),
        overrides.htmlToImage ?? makeHtmlToImage(),
        overrides.rateLimiter ?? new RateLimiter([{ windowMs: 60_000, limit: 100 }]),
    );
}

// ---------------------------------------------------------------------------
// handleMessageCreate
// ---------------------------------------------------------------------------

describe("handleMessageCreate", () => {
    // 9
    it("ignores bot-authored messages", async () => {
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase });
        const msg = makeMessage({ id: "msg-1", isAuthorBot: true });

        await gateway.handleMessageCreate(msg);

        expect(useCase.execute).not.toHaveBeenCalled();
    });

    // 10
    it("ignores UNKNOWN intent with no explicit mention", async () => {
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase });
        // content has no command prefix; hasExplicitMention returns false
        const msg = makeMessage({ id: "msg-1", content: "just a normal message" });

        await gateway.handleMessageCreate(msg);

        expect(useCase.execute).not.toHaveBeenCalled();
    });

    // 11
    it("proceeds when UNKNOWN intent but has explicit mention", async () => {
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase });
        const msg = makeMessage({
            id: "msg-1",
            content: "hey",
            hasExplicitMention: () => true,
        });

        await gateway.handleMessageCreate(msg);

        expect(useCase.execute).toHaveBeenCalled();
    });

    // 12
    it("sends restart notice and saves to DB when shutdown is pending", async () => {
        const messageRepo = makeMessageRepo();
        const gateway = makeGateway({ messageRepo });
        await gateway.gracefulShutdown(); // sets shutdownPending = true

        const msg = makeMessage({ id: "msg-1", content: "!ai hello" });

        await gateway.handleMessageCreate(msg);

        expect(messageRepo.saveAssistantMessage).toHaveBeenCalled();
        // reply should have been called on the message with the restart notice
        expect(msg.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("restart") }),
        );
    });

    // 13
    it("sends rate limit reply and saves to DB when rate limited", async () => {
        // Limiter with limit=0 per window — every call is denied
        const rateLimiter = new RateLimiter([{ windowMs: 60_000, limit: 0 }]);
        const messageRepo = makeMessageRepo();
        const gateway = makeGateway({ rateLimiter, messageRepo });
        const msg = makeMessage({ id: "msg-1", content: "!ai hello" });

        await gateway.handleMessageCreate(msg);

        expect(msg.reply).toHaveBeenCalled();
        expect(messageRepo.saveAssistantMessage).toHaveBeenCalled();
    });

    // 14
    it("injects synthetic greeting when content is empty, no attachments, and no reply reference", async () => {
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase });
        const msg = makeMessage({
            id: "msg-1",
            // Explicit @mention triggers processing; content is the bot mention which strips to ""
            content: `<@${BOT_USER_ID}>`,
            attachments: [],
            referencedMessageId: null,
            hasExplicitMention: () => true,
        });

        await gateway.handleMessageCreate(msg);

        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.message).toBeTruthy();
        expect(callArg?.strippedContent as string).toContain("introduce yourself");
    });

    // 15 + 16
    it("extracts attachments and passes them to the use case; no greeting when attachments present", async () => {
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase });
        const msg = makeMessage({
            id: "msg-1",
            content: `<@${BOT_USER_ID}>`,
            attachments: [makeAttachment("att-1")],
            referencedMessageId: null,
            hasExplicitMention: () => true,
        });

        await gateway.handleMessageCreate(msg);

        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        const attachments = callArg?.attachments as unknown[];
        expect(attachments).toHaveLength(1);
        expect((attachments[0] as { id: string }).id).toBe("att-1");
        // Greeting should NOT be injected because there is an attachment
        expect(callArg?.strippedContent as string | null).not.toContain("introduce yourself");
    });
});

// ---------------------------------------------------------------------------
// handleRetryButton
// ---------------------------------------------------------------------------

describe("handleRetryButton", () => {
    // 17
    it("edits button away and sends ephemeral when original message is missing (channel null)", async () => {
        const gateway = makeGateway();
        const interaction = makeButtonInteraction({
            referencedMessageId: "orig-msg-1",
            channel: null, // no channel → cannot fetch original
        });

        await gateway.handleRetryButton(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
        expect(interaction.message.edit).toHaveBeenCalled();
    });

    // 18
    it("edits button away and sends ephemeral when original message fetch fails", async () => {
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => {
                throw new Error("not found");
            }),
            fetchMessagesAfter: mock(async () => []),
        };
        const gateway = makeGateway();
        const interaction = makeButtonInteraction({
            referencedMessageId: "orig-msg-1",
            channel,
        });

        await gateway.handleRetryButton(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
    });

    // 19
    it("defers and returns immediately when already locked", async () => {
        const useCase = makeUseCase();
        // Fetch succeeds so we get past the early exits; lock is set inside the handler
        const originalMsg = makeMessage({ id: "orig-1" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => []),
        });
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-lock",
            referencedMessageId: "orig-1",
            channel,
        });

        // Simulate lock being held externally by calling twice concurrently:
        // first call sets the lock, second should short-circuit
        const [first, second] = [gateway.handleRetryButton(interaction), gateway.handleRetryButton(interaction)];
        await Promise.allSettled([first, second]);

        // deferUpdate must have been called at least once (locked path)
        expect(interaction.deferUpdate).toHaveBeenCalled();
    });

    // 20 — Scenario A: human message in DB → reuseHumanMessage
    it("Scenario A: calls invokeAgentWithMessage with reuseHumanMessage when human record exists in DB", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "user-1",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 2,
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase, messageRepo });
        // Spy on invokeAgentWithMessage indirectly — it calls useCase.execute
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
        });

        await gateway.handleRetryButton(interaction);

        expect(useCase.execute).toHaveBeenCalled();
        // reuseHumanMessage=true means message is null
        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.message).toBeNull();
    });

    // 21 — Scenario B: human message NOT in DB → handleMessageCreate
    it("Scenario B: runs full pipeline when human message is not in DB", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        // Only bot record, no human record (chain length < 2)
        const botRecord = {
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            discordAuthorId: BOT_USER_ID,
            retriesLeft: 2,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: "orig-1",
            createdAt: BASE_DATE,
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [botRecord]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
        });

        await gateway.handleRetryButton(interaction);

        expect(useCase.execute).toHaveBeenCalled();
        // Scenario B calls handleMessageCreate which passes the live message
        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.message).not.toBeNull();
    });

    // 22
    it("sends ephemeral and does not run agent when wrong user retries a fallback response", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello", authorId: "original-user" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "original-user",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 2,
            usedFallback: true, // ← fallback response
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
        });
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
            userId: "different-user", // ← not the original requester
        });

        await gateway.handleRetryButton(interaction);

        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
        expect(useCase.execute).not.toHaveBeenCalled();
    });

    // 23
    it("uses MessageIntent.SUMMARY when interactionType is summary_command", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "some prose, no command prefix" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "user-1",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "summary_command" as const,
            interactionAuthorDiscordId: "user-1",
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 2,
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const useCase = makeUseCase();
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
            userId: "user-1",
        });

        await gateway.handleRetryButton(interaction);

        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.intent).toBe("summary");
    });

    // 24
    it("decrements retriesLeft from the stored bot record value", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "user-1",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 3, // stored value
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const saveAssistantMessage = mock(async () => ({ id: "new-row" }));
        messageRepo.saveAssistantMessage = saveAssistantMessage;

        // isRetryable=true so the gateway stores a non-null retriesLeft on the saved row
        const useCase = makeUseCase({ isRetryable: true });
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
        });

        await gateway.handleRetryButton(interaction);

        // TYPE COERCION: mock.calls is typed as never[] when the function signature has no rest params
        const saved = (saveAssistantMessage.mock.calls as unknown as [{ retriesLeft: number | null }][])[0]?.[0];
        // retriesLeft should be stored_value - 1 = 2
        expect(saved?.retriesLeft).toBe(2);
    });

    // 25
    it("deletes old reply from Discord and DB before sending new response", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "user-1",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 2,
        };
        const deleteByDiscordMessageId = mock(async () => {});
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
            deleteByDiscordMessageId,
        });
        const gateway = makeGateway({ messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
        });

        await gateway.handleRetryButton(interaction);

        // Discord delete
        expect(interaction.message.delete).toHaveBeenCalled();
        // DB delete
        expect(deleteByDiscordMessageId).toHaveBeenCalledWith(
            expect.objectContaining({ discordMessageId: "bot-msg-1" }),
        );
    });
});

// ---------------------------------------------------------------------------
// handleNextPageButton
// ---------------------------------------------------------------------------

describe("handleNextPageButton", () => {
    // 26
    it("defers and returns immediately when already locked", async () => {
        const getNextPage = makeGetNextPageUseCase(null);
        const gateway = makeGateway({ getNextPage });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-page", customId: "next_page" });

        // Two concurrent calls — second should hit the lock
        const [first, second] = [gateway.handleNextPageButton(interaction), gateway.handleNextPageButton(interaction)];
        await Promise.allSettled([first, second]);

        expect(interaction.deferUpdate).toHaveBeenCalled();
    });

    // 27
    it("removes next-page button and returns when use case throws", async () => {
        const getNextPage = {
            execute: mock(async () => {
                throw new Error("DB error");
            }),
        } as unknown as GetNextPageUseCase;
        const gateway = makeGateway({ getNextPage });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", customId: "next_page" });

        await gateway.handleNextPageButton(interaction);

        expect(interaction.message.edit).toHaveBeenCalled();
        expect(interaction.message.reply).not.toHaveBeenCalled();
    });

    // 28
    it("removes next-page button and returns when use case returns null (stale button)", async () => {
        const gateway = makeGateway({ getNextPage: makeGetNextPageUseCase(null) });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", customId: "next_page" });

        await gateway.handleNextPageButton(interaction);

        expect(interaction.message.edit).toHaveBeenCalled();
        expect(interaction.message.reply).not.toHaveBeenCalled();
    });

    // 29
    it("mid-pagination: sends reply with Next Page button, saves page state, removes old button", async () => {
        const pageResult: GetNextPageResult = {
            content: "Page 2 content",
            newOffset: 400,
            currentPage: 2,
            totalPages: 3,
            isLast: false,
            pageStateId: "ps-1",
            firstPageMessageId: "first-page-row-id",
            endedInCodeBlock: false,
            codeBlockType: null,
        };
        const pageRepo = makePageRepo();
        const messageRepo = makeMessageRepo();
        const gateway = makeGateway({
            getNextPage: makeGetNextPageUseCase(pageResult),
            pageRepo,
            messageRepo,
        });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", customId: "next_page" });

        await gateway.handleNextPageButton(interaction);

        // Reply was sent with a Next Page button
        expect(interaction.message.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                buttons: expect.arrayContaining([expect.objectContaining({ customId: "next_page" })]),
            }),
        );
        // Page state saved
        expect(pageRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({ firstPageMessageId: "first-page-row-id", currentPage: 2 }),
        );
        // Old message Next Page button removed
        expect(interaction.message.edit).toHaveBeenCalled();
    });

    // 30
    it("last page: sends reply with no Next Page button, does not save page state", async () => {
        const pageResult: GetNextPageResult = {
            content: "Final page content",
            newOffset: 800,
            currentPage: 3,
            totalPages: 3,
            isLast: true,
            pageStateId: "ps-2",
            firstPageMessageId: "first-page-row-id",
            endedInCodeBlock: false,
            codeBlockType: null,
        };
        const pageRepo = makePageRepo();
        const gateway = makeGateway({ getNextPage: makeGetNextPageUseCase(pageResult), pageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-last", customId: "next_page" });

        await gateway.handleNextPageButton(interaction);

        expect(interaction.message.reply).toHaveBeenCalledWith(
            expect.not.objectContaining({ buttons: expect.anything() }),
        );
        expect(pageRepo.save).not.toHaveBeenCalled();
    });

    // 31
    it("propagates firstPageMessageId from use case result into saved page state", async () => {
        const pageResult: GetNextPageResult = {
            content: "page content",
            newOffset: 200,
            currentPage: 2,
            totalPages: 4,
            isLast: false,
            pageStateId: "ps-3",
            firstPageMessageId: "the-first-page-id",
            endedInCodeBlock: false,
            codeBlockType: null,
        };
        const pageRepo = makePageRepo();
        const gateway = makeGateway({ getNextPage: makeGetNextPageUseCase(pageResult), pageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-2", customId: "next_page" });

        await gateway.handleNextPageButton(interaction);

        expect(pageRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({ firstPageMessageId: "the-first-page-id" }),
        );
    });
});

// ---------------------------------------------------------------------------
// handleSummarizeContextMenu
// ---------------------------------------------------------------------------

describe("handleSummarizeContextMenu", () => {
    // 32
    it("self-reply: pingUser true, no replyPrefix when invoker === target author", async () => {
        const useCase = makeUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => false) });
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetMessageId: "msg-1",
            targetAuthorId: "user-1",
            userId: "user-1", // same as target author
        });

        await gateway.handleSummarizeContextMenu(interaction);

        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.message).toBeTruthy();
        // replyPrefix should be absent (undefined) — no explicit mention needed
        expect(callArg?.ephemeralInstructionMessage).toBe("Summarize this in English");
    });

    // 33
    it("different user: pingUser false, replyPrefix set to invoker mention", async () => {
        const useCase = makeUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => false) });
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetMessageId: "msg-1",
            targetAuthorId: "author-user",
            userId: "invoker-user", // different from target author
        });

        await gateway.handleSummarizeContextMenu(interaction);

        // The ACK reply should have been sent
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
    });

    // 34
    it("sets reuseHumanMessage true when message already exists in DB", async () => {
        const useCase = makeUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => true) });
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeContextMenuInteraction({ targetMessageId: "msg-1" });

        await gateway.handleSummarizeContextMenu(interaction);

        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.reuseHumanMessage).toBe(true);
    });

    // 35
    it("sets reuseHumanMessage false when message is not in DB", async () => {
        const useCase = makeUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => false) });
        const gateway = makeGateway({ useCase, messageRepo });
        const interaction = makeContextMenuInteraction({ targetMessageId: "msg-1" });

        await gateway.handleSummarizeContextMenu(interaction);

        const callArg = (useCase.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg?.reuseHumanMessage).toBe(false);
    });

    // 36
    it("sends ephemeral ACK reply", async () => {
        const gateway = makeGateway();
        const interaction = makeContextMenuInteraction({});

        await gateway.handleSummarizeContextMenu(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ isEphemeral: true, content: expect.stringContaining("summary") }),
        );
    });
});

// ---------------------------------------------------------------------------
// handleExportHtmlContextMenu / handleExportImageContextMenu
// ---------------------------------------------------------------------------

describe("handleExportHtmlContextMenu", () => {
    // 37
    it("sends ephemeral error when target is not a bot message", async () => {
        const markdownToHtml = makeMarkdownToHtml();
        const gateway = makeGateway({ markdownToHtml });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: "some-random-user", // not the bot
        });

        await gateway.handleExportHtmlContextMenu(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
        expect(markdownToHtml.render).not.toHaveBeenCalled();
    });

    // 38
    it("allows export when target was authored by the previous bot", async () => {
        const PREV_BOT = "old-bot-id";
        const markdownToHtml = makeMarkdownToHtml();
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const gateway = makeGateway({ markdownToHtml, messageRepo, previousBotId: PREV_BOT });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: PREV_BOT,
            targetContent: "old bot response",
        });

        await gateway.handleExportHtmlContextMenu(interaction);

        expect(markdownToHtml.render).toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalled();
    });

    // 39 + 40
    it("prefers DB LangChain content over cleanContent when row exists", async () => {
        const { AIMessage } = await import("@langchain/core/messages");
        const aiMsg = new AIMessage("Full AI response from DB");
        const dbRow = {
            id: "row-1",
            discordMessageId: "target-msg",
            repliesToDiscordId: null,
            role: "assistant" as const,
            discordAuthorId: BOT_USER_ID,
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            // TYPE COERCION: DiscordMessage.langchainMessages is Record<string, unknown>[],
            // aiMsg.toJSON() satisfies that shape at runtime
            langchainMessages: [aiMsg.toJSON() as unknown as Record<string, unknown>],
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            createdAt: BASE_DATE,
        };
        const markdownToHtml = makeMarkdownToHtml("<p>rendered</p>");
        const messageRepo = makeMessageRepo({
            findByDiscordMessageId: mock(async () => dbRow),
        });
        const gateway = makeGateway({ markdownToHtml, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: BOT_USER_ID,
            targetContent: "short clean content",
        });

        await gateway.handleExportHtmlContextMenu(interaction);

        const renderArg = (markdownToHtml.render as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
        expect(renderArg).toContain("Full AI response from DB");
    });

    it("falls back to cleanContent when no DB row exists", async () => {
        const markdownToHtml = makeMarkdownToHtml();
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const gateway = makeGateway({ markdownToHtml, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: BOT_USER_ID,
            targetContent: "clean content fallback",
        });

        await gateway.handleExportHtmlContextMenu(interaction);

        const renderArg = (markdownToHtml.render as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
        expect(renderArg).toBe("clean content fallback");
    });
});

describe("handleExportImageContextMenu", () => {
    // 41
    it("renders HTML to PNG and sends as file attachment", async () => {
        const png = Buffer.from("PNG-DATA");
        const markdownToHtml = makeMarkdownToHtml("<p>html</p>");
        const htmlToImage = makeHtmlToImage(png);
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const gateway = makeGateway({ markdownToHtml, htmlToImage, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: BOT_USER_ID,
            targetContent: "some markdown",
        });

        await gateway.handleExportImageContextMenu(interaction);

        expect(htmlToImage.render).toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                files: expect.arrayContaining([
                    expect.objectContaining({ attachment: png, name: expect.stringMatching(/\.png$/) }),
                ]),
            }),
        );
    });
});

// ---------------------------------------------------------------------------
// handleRenderButton
// ---------------------------------------------------------------------------

describe("handleRenderButton", () => {
    // 42
    it("sends ephemeral 'already rendering' and returns when locked", async () => {
        const htmlToImage = makeHtmlToImage();
        const gateway = makeGateway({ htmlToImage });
        const interaction = makeButtonInteraction({ messageId: "bot-render", customId: "render_image" });

        // Two concurrent calls
        const [first, second] = [gateway.handleRenderButton(interaction), gateway.handleRenderButton(interaction)];
        await Promise.allSettled([first, second]);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
    });

    // 43
    it("renders markdown → HTML → PNG, saves DB row, removes render button", async () => {
        const png = Buffer.from("RENDER");
        const markdownToHtml = makeMarkdownToHtml("<p>rendered</p>");
        const htmlToImage = makeHtmlToImage(png);
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const gateway = makeGateway({ markdownToHtml, htmlToImage, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-render-43",
            customId: "render_image",
            messageContent: "**bold**",
        });

        await gateway.handleRenderButton(interaction);

        expect(markdownToHtml.render).toHaveBeenCalled();
        expect(htmlToImage.render).toHaveBeenCalled();
        // PNG sent as reply to bot message
        expect(interaction.message.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                files: expect.arrayContaining([expect.objectContaining({ attachment: png })]),
            }),
        );
        // Render button removed from original message
        expect(interaction.message.edit).toHaveBeenCalled();
        // DB row saved
        expect(messageRepo.saveAssistantMessage).toHaveBeenCalled();
    });

    // 44
    it("releases the lock in finally even if render throws", async () => {
        const htmlToImage = {
            render: mock(async () => {
                throw new Error("render failed");
            }),
        } as unknown as HtmlToImageRenderer;
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const gateway = makeGateway({ htmlToImage, messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-render-44", customId: "render_image" });

        await gateway.handleRenderButton(interaction).catch(() => {});

        // After the error the lock should be released — a second call should proceed past the lock check
        // (it will also throw, but the point is it gets past the lock)
        const second = gateway.handleRenderButton(interaction);
        await second.catch(() => {});
        // reply (for "already rendering") should NOT have been called, meaning the lock was released
        expect(interaction.reply).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// deleteDanglingSourcesMessageOptimistically (via handleRetryButton)
// ---------------------------------------------------------------------------

describe("deleteDanglingSourcesMessageOptimistically", () => {
    /** Set up a retry scenario where the dangling-sources cleanup runs. */
    function makeRetrySetup(channelMessages: IChatClientMessage[]) {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const sourcesMsg = channelMessages.find((m) => m.content.startsWith("*Sources:"));

        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => channelMessages),
        };

        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "user-1",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 2,
        };

        const deleteByDiscordMessageId = mock(async () => {});
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
            deleteByDiscordMessageId,
        });

        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
        });

        return { channel, sourcesMsg, deleteByDiscordMessageId, messageRepo, interaction };
    }

    it("deletes sources message from Discord and DB when found after deleted message", async () => {
        const sourcesMsg = makeMessage({
            id: "sources-msg-1",
            authorId: BOT_USER_ID,
            isAuthorBot: true,
            content: "*Sources: [Example](<https://example.com>)*",
            referencedMessageId: "bot-msg-1",
        });
        const { deleteByDiscordMessageId, messageRepo, interaction } = makeRetrySetup([sourcesMsg]);
        const gateway = makeGateway({ messageRepo });

        await gateway.handleRetryButton(interaction);

        // Wait a tick for the fire-and-forget promises to settle
        await new Promise((r) => setTimeout(r, 0));

        expect(sourcesMsg.delete).toHaveBeenCalled();
        expect(deleteByDiscordMessageId).toHaveBeenCalledWith(
            expect.objectContaining({ discordMessageId: "sources-msg-1" }),
        );
    });

    it("does nothing when no sources message is found after deleted message", async () => {
        // A bot message that does NOT start with "*Sources:" — should not be touched
        const otherMsg = makeMessage({
            id: "other-bot-msg",
            authorId: BOT_USER_ID,
            isAuthorBot: true,
            content: "Some other bot message",
            referencedMessageId: "bot-msg-1",
        });
        const { deleteByDiscordMessageId, messageRepo, interaction } = makeRetrySetup([otherMsg]);
        const gateway = makeGateway({ messageRepo });

        await gateway.handleRetryButton(interaction);
        await new Promise((r) => setTimeout(r, 0));

        expect(otherMsg.delete).not.toHaveBeenCalled();
        // deleteByDiscordMessageId may be called for the failed bot reply itself, but not for "other-bot-msg"
        const ids = (deleteByDiscordMessageId.mock.calls as unknown as [{ discordMessageId: string }][]).map(
            ([arg]) => arg.discordMessageId,
        );
        expect(ids).not.toContain("other-bot-msg");
    });

    it("does not crash when fetchMessagesAfter throws", async () => {
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => makeMessage({ id: "orig-1", content: "!ai hello" })),
            fetchMessagesAfter: mock(async () => {
                throw new Error("fetch failed");
            }),
        };
        const humanRecord = {
            id: "row-human",
            discordMessageId: "orig-1",
            role: "human" as const,
            discordAuthorId: "user-1",
            retriesLeft: null,
            usedFallback: false,
            interactionType: "message_create" as const,
            interactionAuthorDiscordId: null,
            langchainMessages: [],
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            repliesToDiscordId: null,
            createdAt: BASE_DATE,
        };
        const botRecord = {
            ...humanRecord,
            id: "row-bot",
            discordMessageId: "bot-msg-1",
            role: "assistant" as const,
            repliesToDiscordId: "orig-1",
            retriesLeft: 2,
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [humanRecord, botRecord]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
        });
        const gateway = makeGateway({ messageRepo });

        // Should not throw even though fetchMessagesAfter fails
        await expect(gateway.handleRetryButton(interaction)).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// invokeAgentWithMessage — error path and onStatusUpdate
// ---------------------------------------------------------------------------

describe("invokeAgentWithMessage (via handleMessageCreate)", () => {
    it("edits thinking message to error notice and saves DB row when use case throws", async () => {
        const useCase: HandleDiscordMessageUseCase = {
            execute: mock(async () => {
                throw new Error("orchestrator exploded");
            }),
        } as unknown as HandleDiscordMessageUseCase;
        const messageRepo = makeMessageRepo();
        const gateway = makeGateway({ useCase, messageRepo });

        const thinkingMsg = makeMessage({ id: "thinking-1", authorId: BOT_USER_ID, isAuthorBot: true });
        const editedMsg = makeMessage({ id: "thinking-1", authorId: BOT_USER_ID, isAuthorBot: true });
        thinkingMsg.edit = mock(async () => editedMsg);

        const msg = makeMessage({
            id: "user-msg-1",
            content: "!ai hello",
            // reply returns the thinking placeholder
            reply: mock(async () => thinkingMsg),
        });

        await gateway.handleMessageCreate(msg);

        // Thinking message should have been edited to the error notice
        expect(thinkingMsg.edit).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("error") }),
        );
        // Error message persisted to DB
        expect(messageRepo.saveAssistantMessage).toHaveBeenCalled();
    });

    it("calls statusUpdater.scheduleUpdate when onStatusUpdate is invoked", async () => {
        const statusUpdater = makeStatusUpdater();

        // Capture the onStatusUpdate callback passed to execute, then invoke it
        let capturedOnStatusUpdate: ((update: unknown) => void) | undefined;
        const useCase: HandleDiscordMessageUseCase = {
            execute: mock(async (params: Record<string, unknown>) => {
                capturedOnStatusUpdate = params.onStatusUpdate as (update: unknown) => void;
                // Trigger the callback before resolving
                capturedOnStatusUpdate?.({ type: AgentStatusType.SEARCHING });
                return {
                    response: "done",
                    newMessages: [],
                    isFailure: false,
                    isRetryable: false,
                    usedFallback: false,
                };
            }),
        } as unknown as HandleDiscordMessageUseCase;

        const thinkingMsg = makeMessage({ id: "thinking-2", authorId: BOT_USER_ID, isAuthorBot: true });
        // scheduleUpdate is invoked inside a .then() chained on thinkingMessagePromise,
        // which is a fire-and-forget side chain never awaited by handleMessageCreate.
        // We track when it resolves so the test can await it explicitly.
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

        const gateway = makeGateway({ useCase, statusUpdater });
        await gateway.handleMessageCreate(msg);
        // Wait for the thinkingMessagePromise side chain to settle
        await thinkingSettled;
        await Promise.resolve();

        expect(statusUpdater.scheduleUpdate).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// resolveGroundingSources — bad Google prefix guard (via handleMessageCreate)
// ---------------------------------------------------------------------------

describe("resolveGroundingSources (via handleMessageCreate)", () => {
    it("uses raw URI and logs error when Google redirect URI does not match expected prefix", async () => {
        const { AIMessage } = await import("@langchain/core/messages");

        // AIMessage with grounding metadata containing a non-Google URI
        const aiMsg = new AIMessage({
            content: "search result",
            additional_kwargs: {
                groundingMetadata: {
                    groundingChunks: [{ web: { uri: "https://unexpected.example.com/link", title: "Example" } }],
                },
            },
        });

        const useCase: HandleDiscordMessageUseCase = {
            execute: mock(async () => ({
                response: "search result",
                newMessages: [aiMsg],
                isFailure: false,
                isRetryable: false,
                usedFallback: false,
            })),
        } as unknown as HandleDiscordMessageUseCase;

        // Use google search mode so the prefix guard is hit
        const gateway = makeGateway({ useCase, searchMode: "google" });

        // Spy on logger.error to confirm the guard fires
        const logError = spyOn(logger, "error");

        const msg = makeMessage({ id: "msg-gs", content: "!ai search this", hasExplicitMention: () => true });
        await gateway.handleMessageCreate(msg);

        expect(logError).toHaveBeenCalledWith(
            expect.objectContaining({ uri: "https://unexpected.example.com/link" }),
            expect.stringContaining("redirect prefix"),
        );
    });
});
