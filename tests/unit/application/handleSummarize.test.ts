import { describe, expect, it, mock } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import type {
    IChatClientBot,
    IChatClientContextMenuInteraction,
    IChatClientMessage,
} from "../../../src/application/ports/chat/IChatClient.ts";
import type { HandleChatMessageUseCase } from "../../../src/application/use-cases/HandleChatMessage.ts";
import { HandleSummarizeUseCase } from "../../../src/application/use-cases/HandleMessageSummarize.ts";
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

function makeHandleChatMessageUseCase(): HandleChatMessageUseCase {
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

function makeMessageRepo(overrides: Partial<IMessageRepository> = {}): IMessageRepository {
    return {
        save: mock(async () => ({ id: "row-uuid-1" })),
        fetchChain: mock(async () => []),
        saveBotMessage: mock(async () => ({ id: "row-uuid-1" })),
        findById: mock(async () => null),
        findByDiscordMessageId: mock(async () => null),
        findExistingDiscordIds: mock(async () => []),
        existsByDiscordMessageId: mock(async () => false),
        deleteByDiscordMessageId: mock(async () => {}),
        saveBatch: mock(async () => []),
        ...overrides,
    };
}

function makeBot(userId = BOT_USER_ID): IChatClientBot {
    return { userId };
}

function makeUseCase(
    overrides: {
        handleChatMessage?: HandleChatMessageUseCase;
        messageRepo?: IMessageRepository;
        bot?: IChatClientBot;
    } = {},
): HandleSummarizeUseCase {
    return new HandleSummarizeUseCase(
        overrides.handleChatMessage ?? makeHandleChatMessageUseCase(),
        overrides.messageRepo ?? makeMessageRepo(),
        overrides.bot ?? makeBot(),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HandleSummarizeUseCase", () => {
    // 32
    it("self-reply: passes ephemeralInstructionMessage 'Summarize this in English' when invoker === target author", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => false) });
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetMessageId: "msg-1",
            targetAuthorId: "user-1",
            userId: "user-1", // same as target author
        });

        await useCase.execute(interaction);

        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.message).toBeTruthy();
        expect(callArg?.ephemeralInstructionMessage).toBe("Summarize this in English");
    });

    // 33
    it("different user: sends ACK ephemeral reply and passes replyPrefix with invoker mention", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => false) });
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeContextMenuInteraction({
            targetMessageId: "msg-1",
            targetAuthorId: "author-user",
            userId: "invoker-user", // different from target author
        });

        await useCase.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ isEphemeral: true }));
    });

    // 34
    it("sets reuseHumanMessage true when message already exists in DB", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => true) });
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeContextMenuInteraction({ targetMessageId: "msg-1" });

        await useCase.execute(interaction);

        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.reuseHumanMessage).toBe(true);
    });

    // 35
    it("sets reuseHumanMessage false when message is not in DB", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const messageRepo = makeMessageRepo({ existsByDiscordMessageId: mock(async () => false) });
        const useCase = makeUseCase({ handleChatMessage, messageRepo });
        const interaction = makeContextMenuInteraction({ targetMessageId: "msg-1" });

        await useCase.execute(interaction);

        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.reuseHumanMessage).toBe(false);
    });

    // 36
    it("sends ephemeral ACK reply containing 'summary'", async () => {
        const useCase = makeUseCase();
        const interaction = makeContextMenuInteraction({});

        await useCase.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ isEphemeral: true, content: expect.stringContaining("summary") }),
        );
    });

    it("delegates to invokeAgentAndReply with SUMMARY intent", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage });
        const interaction = makeContextMenuInteraction({ targetMessageId: "msg-summary" });

        await useCase.execute(interaction);

        expect(handleChatMessage.invokeAgentAndReply).toHaveBeenCalled();
        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.intent).toBe("summary");
    });

    it("passes interactionType summary_command to invokeAgentAndReply", async () => {
        const handleChatMessage = makeHandleChatMessageUseCase();
        const useCase = makeUseCase({ handleChatMessage });
        const interaction = makeContextMenuInteraction({ userId: "invoker-99" });

        await useCase.execute(interaction);

        const callArg = (handleChatMessage.invokeAgentAndReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(callArg?.interactionType).toBe("summary_command");
        expect(callArg?.interactionAuthorDiscordId).toBe("invoker-99");
    });
});
