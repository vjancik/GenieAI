import { describe, expect, it } from "bun:test";
import { AIMessage, ChatMessage, FunctionMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import pino from "pino";
import { dbMessagesToLangchain } from "../../../src/application/helpers/messageTransformers.ts";
import type { PersistedChatMessage } from "../../../src/domain/entities/Message.ts";
import { AppError } from "../../../src/domain/errors/AppError.ts";

const logger = pino({ level: "silent" });

function makeRecord(className: string, kwargs: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", className],
        kwargs: { content: "", ...kwargs },
    };
}

function makeDiscordMessage(langchainMessages: Record<string, unknown>[]): PersistedChatMessage {
    return {
        id: "row-1",
        discordMessageId: "discord-1",
        repliesToDiscordId: null,
        channelId: "ch-1",
        guildId: "guild-1",
        role: "human",
        discordAuthorId: "user-1",
        langchainMessages,
        retriesLeft: null,
        usedFallback: null,
        interactionType: null,
        interactionAuthorDiscordId: null,
        createdAt: new Date(),
    } as unknown as PersistedChatMessage;
}

describe("dbMessagesToLangchain — unexpected message types", () => {
    it("deserializes ChatMessage and returns a ChatMessage instance", () => {
        const record = makeRecord("ChatMessage", { content: "chat text", role: "user" });
        const result = dbMessagesToLangchain([makeDiscordMessage([record])], logger);

        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(ChatMessage);
    });

    it("deserializes FunctionMessage and returns a FunctionMessage instance", () => {
        const record = makeRecord("FunctionMessage", { content: "fn result", name: "myFn" });
        const result = dbMessagesToLangchain([makeDiscordMessage([record])], logger);

        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(FunctionMessage);
    });

    it("deserializes RemoveMessage and returns a RemoveMessage instance", () => {
        const record = makeRecord("RemoveMessage", { content: "", id: "msg-to-remove" });
        const result = dbMessagesToLangchain([makeDiscordMessage([record])], logger);

        expect(result).toHaveLength(1);
        expect(result[0]).toBeInstanceOf(RemoveMessage);
    });

    it("throws AppError for SystemMessage in non-production environment", () => {
        const record = makeRecord("SystemMessage", { content: "system prompt" });

        expect(() => dbMessagesToLangchain([makeDiscordMessage([record])], logger)).toThrow(AppError);
    });

    it("throws AppError with UNKNOWN_MESSAGE_TYPE for completely unknown class names", () => {
        const record = makeRecord("BogusMessage", { content: "???" });

        expect(() => dbMessagesToLangchain([makeDiscordMessage([record])], logger)).toThrow(AppError);
    });
});

describe("dbMessagesToLangchain — known types", () => {
    it("deserializes HumanMessage correctly", () => {
        const record = makeRecord("HumanMessage", { content: "hello" });
        const result = dbMessagesToLangchain([makeDiscordMessage([record])], logger);

        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[0]?.content).toBe("hello");
    });

    it("deserializes AIMessage correctly", () => {
        const record = makeRecord("AIMessage", { content: "ai reply" });
        const result = dbMessagesToLangchain([makeDiscordMessage([record])], logger);

        expect(result[0]).toBeInstanceOf(AIMessage);
        expect(result[0]?.content).toBe("ai reply");
    });

    it("flattens multiple messages from a single record", () => {
        const records = [makeRecord("HumanMessage", { content: "q" }), makeRecord("AIMessage", { content: "a" })];
        const result = dbMessagesToLangchain([makeDiscordMessage(records)], logger);

        expect(result).toHaveLength(2);
        expect(result[0]).toBeInstanceOf(HumanMessage);
        expect(result[1]).toBeInstanceOf(AIMessage);
    });
});
