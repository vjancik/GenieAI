import { describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import { HandleDiscordMention } from "../../../src/application/HandleDiscordMention.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import type { Orchestrator } from "../../../src/infrastructure/llm/orchestrator.ts";

const testLogger = pino({ level: "silent" });

const prevAiMessage = new AIMessage("Previous response");

const baseMessage: DiscordMessage = {
    id: "uuid-1",
    discordMessageId: "discord-123",
    repliesToDiscordId: null,
    channelId: "ch-456",
    guildId: "guild-789",
    role: "assistant",
    langchainMessages: [
        prevAiMessage.toJSON() as unknown as Record<string, unknown>,
    ],
    createdAt: new Date("2024-01-01T00:00:00Z"),
};

const mockAiResponse = new AIMessage("AI response");

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
        process: mock(async () => ({
            content: response,
            newMessages: [mockAiResponse],
        })),
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

        expect(result.response).toBe("Hello back!");
        expect(result.newMessages).toHaveLength(1);
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
        // baseMessage has one serialized AIMessage → deserialized to 1 BaseMessage
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

    test("saves the user's message as a serialized HumanMessage", async () => {
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

        const saveCall = (repo.save as ReturnType<typeof mock>).mock
            .calls[0]?.[0] as DiscordMessage;
        expect(saveCall.discordMessageId).toBe("user-msg-1");
        expect(saveCall.repliesToDiscordId).toBe("prev-123");
        expect(saveCall.role).toBe("human");
        // langchainMessages should contain a serialized HumanMessage
        expect(saveCall.langchainMessages).toHaveLength(1);
        // Verify it round-trips correctly via load()
        const reconstructed = await (async () => {
            const { load } = await import("@langchain/core/load");
            return load(JSON.stringify(saveCall.langchainMessages[0]));
        })();
        expect(reconstructed).toBeInstanceOf(HumanMessage);
        expect((reconstructed as HumanMessage).content).toBe("What is 2+2?");
    });
});

describe("HandleDiscordMention.saveBotResponse", () => {
    test("saves bot response with assistant role and serialized messages", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        const aiMsg = new AIMessage("The answer is 4");
        await handler.saveBotResponse({
            botDiscordMessageId: "bot-msg-1",
            repliesToDiscordId: "user-msg-1",
            channelId: "ch-1",
            guildId: "guild-1",
            newMessages: [aiMsg],
        });

        const saveCall = (repo.save as ReturnType<typeof mock>).mock
            .calls[0]?.[0] as DiscordMessage;
        expect(saveCall.discordMessageId).toBe("bot-msg-1");
        expect(saveCall.repliesToDiscordId).toBe("user-msg-1");
        expect(saveCall.role).toBe("assistant");
        expect(saveCall.langchainMessages).toHaveLength(1);
    });

    test("saves multiple newMessages (e.g. triage + tool + final)", async () => {
        const repo = makeRepo();
        const orchestrator = makeOrchestrator();
        const handler = new HandleDiscordMention(
            repo,
            orchestrator as never,
            testLogger,
        );

        const messages = [
            new AIMessage("triage response"),
            new AIMessage("tool result"),
            new AIMessage("final answer"),
        ];

        await handler.saveBotResponse({
            botDiscordMessageId: "bot-msg-1",
            repliesToDiscordId: "user-msg-1",
            channelId: "ch-1",
            guildId: "guild-1",
            newMessages: messages,
        });

        const saveCall = (repo.save as ReturnType<typeof mock>).mock
            .calls[0]?.[0] as DiscordMessage;
        expect(saveCall.langchainMessages).toHaveLength(3);
    });
});
