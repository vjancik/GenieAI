import { describe, expect, it, mock } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import pino from "pino";
import type {
    IChatClientBot,
    IChatClientButtonInteraction,
    IChatClientChannel,
    IChatClientMessage,
} from "../../../src/application/ports/chat/IChatClient.ts";
import type { IInteractionLock } from "../../../src/application/ports/IInteractionLock.ts";
import type { HandleChatMessageUseCase } from "../../../src/application/use-cases/HandleChatMessage.ts";
import { HandleRetryUseCase } from "../../../src/application/use-cases/HandleMessageRetry.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";

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

function makeMessageRepo(overrides: Partial<IMessageRepository> = {}): IMessageRepository {
    return {
        save: mock(async () => ({ id: "row-uuid-1" })),
        fetchChain: mock(async () => []),
        saveBotMessage: mock(async () => ({ id: "row-uuid-1" })),
        findById: mock(async () => null),
        findByDiscordMessageId: mock(async () => null),
        findExistingDiscordIds: mock(async () => []),
        existsByDiscordMessageId: mock(async () => false),
        getIdByDiscordMessageId: mock(async () => null),
        deleteByDiscordMessageId: mock(async () => {}),
        saveBatch: mock(async () => []),
        ...overrides,
    };
}

function makeBot(userId = BOT_USER_ID): IChatClientBot {
    return { userId } as IChatClientBot;
}

function makeChatMessageUseCase(): HandleChatMessageUseCase {
    return {
        execute: mock(async () => {}),
        invokeAgent: mock(async () => ({
            response: "AI response",
            newMessages: [] as BaseMessage[],
            isFailure: false,
            isRetryable: false,
            usedFallback: false,
            thinkingMessagePromise: Promise.resolve(makeMessage({ id: "thinking-stub" })),
        })),
        invokeAgentAndReply: mock(async () => {}),
    } as unknown as HandleChatMessageUseCase;
}

function makeInteractionLock(): IInteractionLock {
    let locked = false;
    return {
        isLocked: mock(() => locked),
        setLocked: mock(() => {
            locked = true;
        }),
        clearLock: mock(() => {
            locked = false;
        }),
    };
}

function makeUseCase(
    overrides: {
        handleChatMessage?: HandleChatMessageUseCase;
        messageRepo?: IMessageRepository;
        bot?: IChatClientBot;
        interactionLock?: IInteractionLock;
    } = {},
): HandleRetryUseCase {
    return new HandleRetryUseCase(
        overrides.handleChatMessage ?? makeChatMessageUseCase(),
        overrides.messageRepo ?? makeMessageRepo(),
        overrides.bot ?? makeBot(),
        logger,
        overrides.interactionLock ?? makeInteractionLock(),
    );
}

// Shared DB records for retry scenarios
function makeHumanRecord(overrides: Partial<Record<string, unknown>> = {}) {
    return {
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
        ...overrides,
    };
}

function makeBotRecord(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        ...makeHumanRecord(),
        id: "row-bot",
        discordMessageId: "bot-msg-1",
        role: "assistant" as const,
        repliesToDiscordId: "orig-1",
        retriesLeft: 2,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HandleRetryUseCase", () => {
    it("sends ephemeral and edits button away when original message is missing (channel null)", async () => {
        const useCase = makeUseCase();
        const interaction = makeButtonInteraction({
            referencedMessageId: "orig-msg-1",
            channel: null,
        });

        await useCase.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
        expect(interaction.message.edit).toHaveBeenCalled();
    });

    it("sends ephemeral and edits button away when original message fetch fails", async () => {
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => {
                throw new Error("not found");
            }),
            fetchMessagesAfter: mock(async () => []),
        };
        const useCase = makeUseCase();
        const interaction = makeButtonInteraction({ referencedMessageId: "orig-msg-1", channel });

        await useCase.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
    });

    it("defers and returns immediately when already locked", async () => {
        const originalMsg = makeMessage({ id: "orig-1" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({ fetchChain: mock(async () => []) });
        // Lock that reports locked on second call
        let calls = 0;
        const interactionLock: IInteractionLock = {
            isLocked: mock(() => calls++ > 0),
            setLocked: mock(() => {}),
            clearLock: mock(() => {}),
        };
        const useCase = makeUseCase({ messageRepo, interactionLock });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-lock",
            referencedMessageId: "orig-1",
            channel,
        });

        const [first, second] = [useCase.execute(interaction), useCase.execute(interaction)];
        await Promise.allSettled([first, second]);

        expect(interaction.deferUpdate).toHaveBeenCalled();
    });

    it("Scenario A: calls invokeAgentAndReply with reuseHumanMessage when human record exists in DB", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await useCase.execute(interaction);

        expect(handleChatMessage.invokeAgentAndReply).toHaveBeenCalled();
        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.userContent).toBeNull();
    });

    it("Scenario B: calls execute (full pipeline) when human message is not in DB", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeBotRecord()]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await useCase.execute(interaction);

        expect(handleChatMessage.execute).toHaveBeenCalled();
    });

    it("sends ephemeral and skips agent when wrong user retries a fallback response", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello", authorId: "original-user" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [
                makeHumanRecord({ discordAuthorId: "original-user" }),
                makeBotRecord({ usedFallback: true }),
            ]),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
            userId: "different-user",
        });

        await useCase.execute(interaction);

        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
        expect(handleChatMessage.execute).not.toHaveBeenCalled();
        expect(handleChatMessage.invokeAgentAndReply).not.toHaveBeenCalled();
    });

    it("uses MessageIntent.SUMMARY when interactionType is summary_command", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "some prose, no command prefix" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [
                makeHumanRecord({ interactionType: "summary_command", interactionAuthorDiscordId: "user-1" }),
                makeBotRecord({ interactionType: "summary_command", interactionAuthorDiscordId: "user-1" }),
            ]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({
            messageId: "bot-msg-1",
            referencedMessageId: "orig-1",
            channel,
            userId: "user-1",
        });

        await useCase.execute(interaction);

        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.intent).toBe("summary");
    });

    it("decrements retriesLeft from the stored bot record value", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord({ retriesLeft: 3 })]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await useCase.execute(interaction);

        const callArg = (
            (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls as unknown as [
                { retriesLeft: number | null },
            ][]
        )[0]?.[0];
        expect(callArg?.retriesLeft).toBe(2);
    });

    it("deletes old reply from Discord and DB before sending new response", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const deleteByDiscordMessageId = mock(async () => {});
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId,
        });
        const useCase = makeUseCase({ messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await useCase.execute(interaction);

        expect(interaction.message.delete).toHaveBeenCalled();
        expect(deleteByDiscordMessageId).toHaveBeenCalledWith(
            expect.objectContaining({ discordMessageId: "bot-msg-1" }),
        );
    });

    it("deletes dangling sources message from Discord and DB when found after deleted message", async () => {
        const sourcesMsg = makeMessage({
            id: "sources-msg-1",
            authorId: BOT_USER_ID,
            isAuthorBot: true,
            content: "*Sources: [Example](<https://example.com>)*",
            referencedMessageId: "bot-msg-1",
        });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => makeMessage({ id: "orig-1", content: "!ai hello" })),
            fetchMessagesAfter: mock(async () => [sourcesMsg]),
        };
        const deleteByDiscordMessageId = mock(async () => {});
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId,
        });
        const useCase = makeUseCase({ messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await useCase.execute(interaction);
        await new Promise((r) => setTimeout(r, 0));

        expect(sourcesMsg.delete).toHaveBeenCalled();
        expect(deleteByDiscordMessageId).toHaveBeenCalledWith(
            expect.objectContaining({ discordMessageId: "sources-msg-1" }),
        );
    });

    it("does not delete non-sources bot messages during dangling cleanup", async () => {
        const otherMsg = makeMessage({
            id: "other-bot-msg",
            authorId: BOT_USER_ID,
            isAuthorBot: true,
            content: "Some other bot message",
            referencedMessageId: "bot-msg-1",
        });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => makeMessage({ id: "orig-1", content: "!ai hello" })),
            fetchMessagesAfter: mock(async () => [otherMsg]),
        };
        const deleteByDiscordMessageId = mock(async () => {});
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId,
        });
        const useCase = makeUseCase({ messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await useCase.execute(interaction);
        await new Promise((r) => setTimeout(r, 0));

        expect(otherMsg.delete).not.toHaveBeenCalled();
        const ids = (deleteByDiscordMessageId.mock.calls as unknown as [{ discordMessageId: string }][]).map(
            ([arg]) => arg.discordMessageId,
        );
        expect(ids).not.toContain("other-bot-msg");
    });

    it("continues with retry when interaction.message.delete() throws", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });
        // Override delete to throw — retry should still proceed
        (interaction.message.delete as ReturnType<typeof mock>).mockImplementation(async () => {
            throw new Error("Discord delete failed");
        });

        await useCase.execute(interaction);

        // Agent should still have been called despite the delete failure
        expect(handleChatMessage.invokeAgentAndReply).toHaveBeenCalled();
    });

    it("continues with retry when deleteByDiscordMessageId throws", async () => {
        const originalMsg = makeMessage({ id: "orig-1", content: "!ai hello" });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => originalMsg),
            fetchMessagesAfter: mock(async () => []),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId: mock(async () => {
                throw new Error("DB delete failed");
            }),
        });
        const handleChatMessage = makeChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        // Should not throw even though DB delete fails (fire-and-forget)
        await expect(useCase.execute(interaction)).resolves.toBeUndefined();
        expect(handleChatMessage.invokeAgentAndReply).toHaveBeenCalled();
    });

    it("does not crash when sources message delete() throws during dangling cleanup", async () => {
        const sourcesMsg = makeMessage({
            id: "sources-msg-1",
            authorId: BOT_USER_ID,
            isAuthorBot: true,
            content: "*Sources: [Example](<https://example.com>)*",
            referencedMessageId: "bot-msg-1",
        });
        // Override delete on sourcesMsg to throw
        (sourcesMsg.delete as ReturnType<typeof mock>).mockImplementation(async () => {
            throw new Error("sources delete failed");
        });
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => makeMessage({ id: "orig-1", content: "!ai hello" })),
            fetchMessagesAfter: mock(async () => [sourcesMsg]),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const useCase = makeUseCase({ messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await expect(useCase.execute(interaction)).resolves.toBeUndefined();
    });

    it("does not crash when fetchMessagesAfter throws during dangling cleanup", async () => {
        const channel: IChatClientChannel = {
            fetchMessage: mock(async () => makeMessage({ id: "orig-1", content: "!ai hello" })),
            fetchMessagesAfter: mock(async () => {
                throw new Error("fetch failed");
            }),
        };
        const messageRepo = makeMessageRepo({
            fetchChain: mock(async () => [makeHumanRecord(), makeBotRecord()]),
            deleteByDiscordMessageId: mock(async () => {}),
        });
        const useCase = makeUseCase({ messageRepo });
        const interaction = makeButtonInteraction({ messageId: "bot-msg-1", referencedMessageId: "orig-1", channel });

        await expect(useCase.execute(interaction)).resolves.toBeUndefined();
    });
});
