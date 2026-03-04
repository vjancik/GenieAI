import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { HandleDiscordMention } from "../../../src/application/HandleDiscordMention.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import type { Orchestrator } from "../../../src/infrastructure/llm/orchestrator.ts";

const testLogger = pino({ level: "silent" });

const baseMessage: DiscordMessage = {
    id: "uuid-1",
    discordMessageId: "discord-123",
    repliesToDiscordId: null,
    channelId: "ch-456",
    guildId: "guild-789",
    role: "assistant",
    contentChunks: [{ type: "text", text: "Previous response" }],
    createdAt: new Date("2024-01-01T00:00:00Z"),
};

function makeRepo(chainMessages: DiscordMessage[] = []): IMessageRepository {
    return {
        save: mock(async (msg) => ({
            ...msg,
            id: "new-uuid",
            createdAt: new Date(),
        })),
        fetchChain: mock(async () => chainMessages),
    };
}

function makeOrchestrator(
    response = "AI response",
): Pick<Orchestrator, "process"> {
    return {
        process: mock(async () => response),
    };
}

describe("HandleDiscordMention.handle", () => {
    test("returns the orchestrator response", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator("Hello back!");
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        const result = await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Hello",
        });

        expect(result).toBe("Hello back!");
    });

    test("does not fetch chain when referencedMessageId is null", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: null,
            userContent: "Hello",
        });

        expect(repo.fetchChain).not.toHaveBeenCalled();
    });

    test("fetches chain when referencedMessageId is set", async () => {
        const repo = makeRepo([baseMessage]);
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        await handler.handle({
            discordMessageId: "user-msg-2",
            referencedMessageId: "discord-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Follow-up",
        });

        expect(repo.fetchChain).toHaveBeenCalledWith("discord-123");
    });

    test("passes fetched history to orchestrator as LangChain messages", async () => {
        const repo = makeRepo([baseMessage]);
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        await handler.handle({
            discordMessageId: "user-msg-2",
            referencedMessageId: "discord-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "Follow-up",
        });

        const firstCall = (orchestrator.process as ReturnType<typeof mock>).mock
            .calls[0];
        expect(firstCall).toBeDefined();
        const [history, userMessage] = firstCall as [unknown[], string];
        expect(history).toHaveLength(1);
        expect(userMessage).toBe("Follow-up");
    });

    test("passes empty history to orchestrator when no reply chain", async () => {
        const repo = makeRepo([]);
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: null,
            channelId: "ch-1",
            guildId: null,
            userContent: "Hello",
        });

        const firstCall = (orchestrator.process as ReturnType<typeof mock>).mock
            .calls[0];
        expect(firstCall).toBeDefined();
        const [history] = firstCall as [unknown[], string];
        expect(history).toHaveLength(0);
    });

    test("saves the user's message with correct role and content", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        await handler.handle({
            discordMessageId: "user-msg-1",
            referencedMessageId: "prev-123",
            channelId: "ch-1",
            guildId: "guild-1",
            userContent: "What is 2+2?",
        });

        expect(repo.save).toHaveBeenCalledWith(
            expect.objectContaining({
                discordMessageId: "user-msg-1",
                repliesToDiscordId: "prev-123",
                role: "human",
                contentChunks: [{ type: "text", text: "What is 2+2?" }],
            }),
        );
    });
});

describe("HandleDiscordMention.saveBotResponse", () => {
    test("saves bot response with assistant role", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        await handler.saveBotResponse({
            botDiscordMessageId: "bot-msg-1",
            repliesToDiscordId: "user-msg-1",
            channelId: "ch-1",
            guildId: "guild-1",
            response: "The answer is 4",
        });

        expect(repo.save).toHaveBeenCalledWith(
            expect.objectContaining({
                discordMessageId: "bot-msg-1",
                repliesToDiscordId: "user-msg-1",
                role: "assistant",
                contentChunks: [{ type: "text", text: "The answer is 4" }],
            }),
        );
    });
});
