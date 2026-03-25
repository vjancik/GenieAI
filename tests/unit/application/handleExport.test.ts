import { describe, expect, it, mock } from "bun:test";
import type {
    IChatClientBot,
    IChatClientButtonInteraction,
    IChatClientContextMenuInteraction,
    IChatClientMessage,
} from "../../../src/application/ports/chat/IChatClient.ts";
import type { IImageRenderer } from "../../../src/application/ports/IImageRenderer.ts";
import type { IInteractionLock } from "../../../src/application/ports/IInteractionLock.ts";
import type { IMarkdownRenderer } from "../../../src/application/ports/IMarkdownRenderer.ts";
import { HandleExportUseCase } from "../../../src/application/use-cases/HandleMessageExport.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeButtonInteraction(overrides: {
    messageId?: string;
    messageContent?: string;
    messageButtons?: IChatClientMessage["buttons"];
    customId?: string;
    userId?: string;
}): IChatClientButtonInteraction {
    const msg = makeMessage({
        id: overrides.messageId ?? "bot-msg-1",
        content: overrides.messageContent ?? "**bold**",
        authorId: BOT_USER_ID,
        isAuthorBot: true,
        buttons: overrides.messageButtons,
    });
    return {
        message: msg,
        channel: null,
        customId: overrides.customId ?? "render_image",
        userId: overrides.userId ?? "user-1",
        deferUpdate: mock(async () => {}),
        reply: mock(async () => {}),
        followUp: mock(async () => {}),
    };
}

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

function makeMarkdownRenderer(html = "<p>html</p>"): IMarkdownRenderer {
    return { render: mock(() => html) };
}

function makeImageRenderer(png = Buffer.from("PNG")): IImageRenderer {
    return { render: mock(async () => png) };
}

function makeBot(userId = BOT_USER_ID): IChatClientBot {
    return { userId };
}

/** Stateful IInteractionLock stub. */
function makeLock(): IInteractionLock {
    const locked = new Set<string>();
    return {
        isLocked: (messageId, customId) => locked.has(`${messageId}:${customId}`),
        setLocked: (messageId, customId) => locked.add(`${messageId}:${customId}`),
        clearLock: (messageId, customId) => locked.delete(`${messageId}:${customId}`),
    };
}

function makeUseCase(
    overrides: {
        messageRepo?: IMessageRepository;
        markdownRenderer?: IMarkdownRenderer;
        imageRenderer?: IImageRenderer;
        bot?: IChatClientBot;
        previousBotId?: string;
        lock?: IInteractionLock;
    } = {},
): HandleExportUseCase {
    return new HandleExportUseCase(
        overrides.messageRepo ?? makeMessageRepo(),
        overrides.markdownRenderer ?? makeMarkdownRenderer(),
        overrides.imageRenderer ?? makeImageRenderer(),
        overrides.bot ?? makeBot(),
        // Logger not needed — pass null-object pino child
        {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            child: () => ({}),
        } as unknown as import("../../../src/application/types/Logger.ts").Logger,
        overrides.previousBotId,
        overrides.lock ?? makeLock(),
    );
}

// ---------------------------------------------------------------------------
// handleExportHtml
// ---------------------------------------------------------------------------

describe("HandleExportUseCase.handleExportHtml", () => {
    // 37
    it("sends ephemeral error when target is not a bot message", async () => {
        const markdownRenderer = makeMarkdownRenderer();
        const useCase = makeUseCase({ markdownRenderer });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: "some-random-user", // not the bot
        });

        await useCase.handleExportHtml(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
        expect(markdownRenderer.render).not.toHaveBeenCalled();
    });

    // 38
    it("allows export when target was authored by the previous bot", async () => {
        const PREV_BOT = "old-bot-id";
        const markdownRenderer = makeMarkdownRenderer();
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const useCase = makeUseCase({ markdownRenderer, messageRepo, previousBotId: PREV_BOT });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: PREV_BOT,
            targetContent: "old bot response",
        });

        await useCase.handleExportHtml(interaction);

        expect(markdownRenderer.render).toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalled();
    });

    // 39
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
        const markdownRenderer = makeMarkdownRenderer("<p>rendered</p>");
        const messageRepo = makeMessageRepo({
            findByDiscordMessageId: mock(async () => dbRow),
        });
        const useCase = makeUseCase({ markdownRenderer, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: BOT_USER_ID,
            targetContent: "short clean content",
        });

        await useCase.handleExportHtml(interaction);

        const renderArg = (markdownRenderer.render as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
        expect(renderArg).toContain("Full AI response from DB");
    });

    // 40
    it("falls back to cleanContent when no DB row exists", async () => {
        const markdownRenderer = makeMarkdownRenderer();
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const useCase = makeUseCase({ markdownRenderer, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: BOT_USER_ID,
            targetContent: "clean content fallback",
        });

        await useCase.handleExportHtml(interaction);

        const renderArg = (markdownRenderer.render as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
        expect(renderArg).toBe("clean content fallback");
    });
});

// ---------------------------------------------------------------------------
// handleExportImage
// ---------------------------------------------------------------------------

describe("HandleExportUseCase.handleExportImage", () => {
    // 41
    it("renders HTML to PNG and sends as file attachment", async () => {
        const png = Buffer.from("PNG-DATA");
        const markdownRenderer = makeMarkdownRenderer("<p>html</p>");
        const imageRenderer = makeImageRenderer(png);
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const useCase = makeUseCase({ markdownRenderer, imageRenderer, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetAuthorId: BOT_USER_ID,
            targetContent: "some markdown",
        });

        await useCase.handleExportImage(interaction);

        expect(imageRenderer.render).toHaveBeenCalled();
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
// handleRender
// ---------------------------------------------------------------------------

describe("HandleExportUseCase.handleRender", () => {
    // 42
    it("sends ephemeral 'already rendering' and returns when locked", async () => {
        const lock = makeLock();
        const imageRenderer = makeImageRenderer();
        const useCase = makeUseCase({ imageRenderer, lock });
        const interaction = makeButtonInteraction({ messageId: "bot-render" });

        // Two concurrent calls
        const [first, second] = [useCase.handleRender(interaction), useCase.handleRender(interaction)];
        await Promise.allSettled([first, second]);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
    });

    // 43
    it("renders markdown → HTML → PNG, saves DB row, removes render button", async () => {
        const png = Buffer.from("RENDER");
        const markdownRenderer = makeMarkdownRenderer("<p>rendered</p>");
        const imageRenderer = makeImageRenderer(png);
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const useCase = makeUseCase({ markdownRenderer, imageRenderer, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-render-43",
            messageContent: "**bold**",
        });

        await useCase.handleRender(interaction);

        expect(markdownRenderer.render).toHaveBeenCalled();
        expect(imageRenderer.render).toHaveBeenCalled();
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
    it("releases the lock even if render throws", async () => {
        const lock = makeLock();
        const imageRenderer: IImageRenderer = {
            render: mock(async () => {
                throw new Error("render failed");
            }),
        };
        const messageRepo = makeMessageRepo({ findByDiscordMessageId: mock(async () => null) });
        const useCase = makeUseCase({ imageRenderer, messageRepo, lock });
        const interaction = makeButtonInteraction({ messageId: "bot-render-44" });

        await useCase.handleRender(interaction).catch(() => {});

        // Lock should be released — a second call should proceed past the lock check
        // (it will also throw, but the point is it gets past the lock)
        const second = useCase.handleRender(interaction);
        await second.catch(() => {});
        // reply (for "already rendering") should NOT have been called, meaning the lock was released
        expect(interaction.reply).not.toHaveBeenCalled();
    });
});
