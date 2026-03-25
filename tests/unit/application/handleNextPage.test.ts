import { describe, expect, it, mock } from "bun:test";
import pino from "pino";
import type {
    IChatClientBot,
    IChatClientButtonInteraction,
    IChatClientMessage,
} from "../../../src/application/ports/chat/IChatClient.ts";
import type { IGetNextPageQuery, NextPageData } from "../../../src/application/ports/IGetNextPageQuery.ts";
import type { IInteractionLock } from "../../../src/application/ports/IInteractionLock.ts";
import { HandleNextPageUseCase } from "../../../src/application/use-cases/HandleMessageNextPage.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";
import type { IMessagePageRepository } from "../../../src/domain/message/MessagePage.ts";

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

function makeButtonInteraction(overrides: {
    messageId?: string;
    messageContent?: string;
    messageButtons?: IChatClientMessage["buttons"];
    customId?: string;
    userId?: string;
}): IChatClientButtonInteraction {
    const msg = makeMessage({
        id: overrides.messageId ?? "bot-msg-1",
        content: overrides.messageContent ?? "bot response",
        authorId: BOT_USER_ID,
        isAuthorBot: true,
        buttons: overrides.messageButtons,
    });

    return {
        message: msg,
        channel: null,
        customId: overrides.customId ?? "next_page",
        userId: overrides.userId ?? "user-1",
        deferUpdate: mock(async () => {}),
        reply: mock(async () => {}),
        followUp: mock(async () => {}),
    };
}

/** Builds a stub IGetNextPageQuery returning the given result (or null). */
function makeGetNextPageQuery(result: NextPageData | null = null): IGetNextPageQuery {
    return { execute: mock(async () => result) } as unknown as IGetNextPageQuery;
}

/** Builds a NextPageData with sensible defaults for non-last page. */
function makePageData(overrides: Partial<NextPageData> = {}): NextPageData {
    // A minimal LangChain AI message JSON blob whose text is long enough to page
    const aiMsgJson = {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
            content: "A".repeat(4000), // 4000 chars — well above 2000-char Discord limit
        },
    };
    return {
        pageStateId: "ps-1",
        firstPageMessageId: "first-page-row-id",
        endOffset: 2000,
        currentPage: 1,
        totalPages: 2,
        endedInCodeBlock: false,
        codeBlockType: null,
        langchainMessages: [aiMsgJson as unknown as Record<string, unknown>],
        ...overrides,
    };
}

/** Builds a stub IMessageRepository. */
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

/** Builds a stub IChatClientBot. */
function makeBot(userId = BOT_USER_ID): IChatClientBot {
    return { userId };
}

/** Stateful IInteractionLock stub — mirrors the real InteractionLock behaviour. */
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
        query?: IGetNextPageQuery;
        messageRepo?: IMessageRepository;
        pageRepo?: IMessagePageRepository;
        bot?: IChatClientBot;
        lock?: IInteractionLock;
    } = {},
): HandleNextPageUseCase {
    return new HandleNextPageUseCase(
        overrides.query ?? makeGetNextPageQuery(),
        overrides.messageRepo ?? makeMessageRepo(),
        overrides.pageRepo ?? makePageRepo(),
        overrides.bot ?? makeBot(),
        logger,
        overrides.lock ?? makeLock(),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HandleNextPageUseCase", () => {
    // 26
    it("defers and returns immediately when already locked", async () => {
        const lock = makeLock();
        const useCase = makeUseCase({ lock });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-page" });

        // Two concurrent calls — second should hit the lock
        const [first, second] = [useCase.execute(interaction), useCase.execute(interaction)];
        await Promise.allSettled([first, second]);

        expect(interaction.deferUpdate).toHaveBeenCalled();
    });

    // 27
    it("removes next-page button and returns when query throws", async () => {
        const query: IGetNextPageQuery = {
            execute: mock(async () => {
                throw new Error("DB error");
            }),
        };
        const useCase = makeUseCase({ query });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1" });

        await useCase.execute(interaction);

        expect(interaction.message.edit).toHaveBeenCalled();
        expect(interaction.message.reply).not.toHaveBeenCalled();
    });

    // 28
    it("removes next-page button and returns when query returns null (stale button)", async () => {
        const useCase = makeUseCase({ query: makeGetNextPageQuery(null) });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1" });

        await useCase.execute(interaction);

        expect(interaction.message.edit).toHaveBeenCalled();
        expect(interaction.message.reply).not.toHaveBeenCalled();
    });

    // 29
    it("mid-pagination: sends reply with Next Page button, saves page state, removes old button", async () => {
        const pageData = makePageData({
            currentPage: 1,
            totalPages: 3,
            endOffset: 2000,
        });
        const pageRepo = makePageRepo();
        const messageRepo = makeMessageRepo();
        const useCase = makeUseCase({
            query: makeGetNextPageQuery(pageData),
            pageRepo,
            messageRepo,
        });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1" });

        await useCase.execute(interaction);

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
        const pageData = makePageData({
            currentPage: 1,
            totalPages: 2,
            endOffset: 2000,
        });
        const pageRepo = makePageRepo();
        const useCase = makeUseCase({
            query: makeGetNextPageQuery(pageData),
            pageRepo,
        });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-last" });

        await useCase.execute(interaction);

        // Reply sent without any buttons
        const replyCall = (interaction.message.reply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(replyCall).not.toHaveProperty("buttons");
        expect(pageRepo.save).not.toHaveBeenCalled();
    });

    // 31
    it("propagates firstPageMessageId from query result into saved page state", async () => {
        const pageData = makePageData({
            currentPage: 1,
            totalPages: 4,
            endOffset: 2000,
            firstPageMessageId: "the-first-page-id",
        });
        const pageRepo = makePageRepo();
        const useCase = makeUseCase({
            query: makeGetNextPageQuery(pageData),
            pageRepo,
        });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-2" });

        await useCase.execute(interaction);

        expect(pageRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({ firstPageMessageId: "the-first-page-id" }),
        );
    });

    it("removes next-page button and returns when langchainMessages array is empty", async () => {
        const pageData = makePageData({ langchainMessages: [] });
        const useCase = makeUseCase({ query: makeGetNextPageQuery(pageData) });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-empty" });

        await useCase.execute(interaction);

        // No reply should be sent when there's nothing to paginate
        expect(interaction.message.reply).not.toHaveBeenCalled();
        // Button should be removed
        expect(interaction.message.edit).toHaveBeenCalled();
    });

    it("does not save page state when reply throws", async () => {
        const pageData = makePageData({ currentPage: 1, totalPages: 3, endOffset: 2000 });
        const pageRepo = makePageRepo();
        const useCase = makeUseCase({
            query: makeGetNextPageQuery(pageData),
            pageRepo,
        });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-reply-throws" });
        // Override reply to throw
        (interaction.message.reply as ReturnType<typeof mock>).mockImplementation(async () => {
            throw new Error("Discord API error");
        });

        await useCase.execute(interaction);

        // Page state must not be saved when the reply failed
        expect(pageRepo.save).not.toHaveBeenCalled();
    });

    it("paginates correctly when langchainMessages content is an array of text parts (structured content)", async () => {
        // Covers extractTextFromMessageJson array-content branch (lines 57-61)
        const structuredMsgJson = {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
                content: [
                    { type: "text", text: "A".repeat(2000) },
                    { type: "text", text: "B".repeat(2000) },
                    // thought chunk — should be filtered out
                    { type: "text", text: "hidden thought", thought: true },
                ],
            },
        };
        const pageData = makePageData({
            langchainMessages: [structuredMsgJson as unknown as Record<string, unknown>],
            endOffset: 2000,
            currentPage: 1,
            totalPages: 2,
        });
        const useCase = makeUseCase({ query: makeGetNextPageQuery(pageData) });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-structured" });

        await useCase.execute(interaction);

        // Reply should be sent because total text (4000 chars) still needs paging
        expect(interaction.message.reply).toHaveBeenCalled();
    });

    it("releases the lock even when an error is thrown during execution", async () => {
        const lock = makeLock();
        const query: IGetNextPageQuery = {
            execute: mock(async () => {
                throw new Error("unexpected error");
            }),
        };
        const useCase = makeUseCase({ query, lock });
        const interaction = makeButtonInteraction({ messageId: "bot-lock-err" });

        await useCase.execute(interaction);

        // Lock must be clear after execution; a second call should proceed (not early-return)
        expect(lock.isLocked(interaction.message.id, interaction.customId)).toBe(false);
    });
});
