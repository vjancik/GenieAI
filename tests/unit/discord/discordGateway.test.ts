import { describe, expect, it, mock } from "bun:test";
import pino from "pino";
import type { IChatClientMessage } from "../../../src/application/ports/chat/IChatClient.ts";
import type { HandleChatMessageUseCase } from "../../../src/application/use-cases/HandleChatMessage.ts";
import type { HandleExportUseCase } from "../../../src/application/use-cases/HandleMessageExport.ts";
import type { HandleNextPageUseCase } from "../../../src/application/use-cases/HandleMessageNextPage.ts";
import type { HandleRetryUseCase } from "../../../src/application/use-cases/HandleMessageRetry.ts";
import type { HandleSummarizeUseCase } from "../../../src/application/use-cases/HandleMessageSummarize.ts";
import type { DiscordClient } from "../../../src/infrastructure/discord/DiscordClient.ts";
import { DiscordGateway } from "../../../src/infrastructure/discord/DiscordGateway.ts";
import { RateLimiter } from "../../../src/infrastructure/discord/RateLimiter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: "silent" });

const BASE_DATE = new Date("2024-06-01T12:00:00Z");
const BOT_USER_ID = "bot-1";
const CHANNEL_ID = "ch-1";
const GUILD_ID = "guild-1";

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
        isDM: false,
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
        isDM: overrides.isDM ?? false,
        hasExplicitMention: overrides.hasExplicitMention ?? (() => false),
        reply: overrides.reply ?? mock(async () => sent),
        edit: overrides.edit ?? mock(async () => sent),
        delete: overrides.delete ?? mock(async () => {}),
    };
}

/** Builds a stub DiscordClient. */
function makeDiscordClient(userId = BOT_USER_ID): DiscordClient {
    return {
        client: { user: { id: userId }, on: () => {} },
    } as unknown as DiscordClient;
}

function makeHandleChatMessageUseCase(): HandleChatMessageUseCase {
    return {
        execute: mock(async () => {}),
        invokeAgent: mock(async () => ({})),
        invokeAgentAndReply: mock(async () => {}),
    } as unknown as HandleChatMessageUseCase;
}

function makeHandleNextPageUseCase(): HandleNextPageUseCase {
    return { execute: mock(async () => {}) } as unknown as HandleNextPageUseCase;
}

function makeHandleRetryUseCase(): HandleRetryUseCase {
    return { execute: mock(async () => {}) } as unknown as HandleRetryUseCase;
}

function makeHandleSummarizeUseCase(): HandleSummarizeUseCase {
    return { execute: mock(async () => {}) } as unknown as HandleSummarizeUseCase;
}

function makeHandleExportUseCase(): HandleExportUseCase {
    return {
        handleExportHtml: mock(async () => {}),
        handleExportImage: mock(async () => {}),
        handleRender: mock(async () => {}),
    } as unknown as HandleExportUseCase;
}

/** Constructs a DiscordGateway with all dependencies stubbed. */
function makeGateway(
    overrides: {
        handleChatMessage?: HandleChatMessageUseCase;
        handleNextPage?: HandleNextPageUseCase;
        handleRetry?: HandleRetryUseCase;
        handleSummarize?: HandleSummarizeUseCase;
        handleExport?: HandleExportUseCase;
        rateLimiter?: RateLimiter;
    } = {},
): DiscordGateway {
    const discordClient = makeDiscordClient();
    (discordClient.client as unknown as Record<string, unknown>).on = () => {};

    return new DiscordGateway(
        discordClient,
        overrides.handleChatMessage ?? makeHandleChatMessageUseCase(),
        logger,
        overrides.handleNextPage ?? makeHandleNextPageUseCase(),
        overrides.handleRetry ?? makeHandleRetryUseCase(),
        overrides.handleSummarize ?? makeHandleSummarizeUseCase(),
        overrides.handleExport ?? makeHandleExportUseCase(),
        overrides.rateLimiter ?? new RateLimiter([{ windowMs: 60_000, limit: 100 }]),
    );
}

// ---------------------------------------------------------------------------
// handleMessageCreate
// ---------------------------------------------------------------------------

describe("DiscordGateway.handleMessageCreate", () => {
    it("delegates to HandleChatMessageUseCase.execute", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const gateway = makeGateway({ handleChatMessage });
        const message = makeMessage({ id: "msg-1", authorId: "user-1" });

        await gateway.handleMessageCreate(message);

        expect(handleChatMessage.execute).toHaveBeenCalled();
    });

    it("marks isRateLimited true when rate limit is exceeded", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        // Rate limiter with limit=1 so the second call is blocked
        const rateLimiter = new RateLimiter([{ windowMs: 60_000, limit: 1 }]);
        const gateway = makeGateway({ handleChatMessage, rateLimiter });
        const message = makeMessage({ id: "msg-rl", authorId: "user-rl" });

        // First call consumes the budget
        await gateway.handleMessageCreate(message);
        // Second call should be rate-limited
        await gateway.handleMessageCreate(message);

        const calls = (handleChatMessage.execute as ReturnType<typeof mock>).mock.calls as unknown as [
            { isRateLimited: boolean },
        ][];
        const secondCallArg = calls[1]?.[0];
        expect(secondCallArg?.isRateLimited).toBe(true);
    });

    it("passes retriesLeft through to the use case", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const gateway = makeGateway({ handleChatMessage });
        const message = makeMessage({ id: "msg-retry", authorId: "user-1" });

        await gateway.handleMessageCreate(message, 2);

        const callArg = (handleChatMessage.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.retriesLeft).toBe(2);
    });

    it("passes shutdownPending false in normal operation", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const gateway = makeGateway({ handleChatMessage });
        const message = makeMessage({ id: "msg-2" });

        await gateway.handleMessageCreate(message);

        const callArg = (handleChatMessage.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.shutdownPending).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// gracefulShutdown
// ---------------------------------------------------------------------------

describe("DiscordGateway.gracefulShutdown", () => {
    it("resolves immediately when there are no in-flight handlers", async () => {
        const gateway = makeGateway();
        await expect(gateway.gracefulShutdown()).resolves.toBeUndefined();
    });
});
