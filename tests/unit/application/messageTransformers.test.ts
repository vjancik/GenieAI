import { describe, expect, it } from "bun:test";
import { AIMessage, ChatMessage, FunctionMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import pino from "pino";
import {
    dbMessagesToLangchain,
    extractContent,
    extractInlineDataBlocksAsAttachments,
    replaceInlineDataBlocksWithDiscordTokenUrls,
} from "../../../src/application/helpers/messageTransformers.ts";
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

describe("extractContent", () => {
    it("returns string content as-is", () => {
        const msg = new AIMessage("hello world");
        expect(extractContent(msg)).toBe("hello world");
    });

    it("joins plain text parts", () => {
        const msg = new AIMessage({
            content: [
                { type: "text", text: "foo" },
                { type: "text", text: "bar" },
            ],
        });
        expect(extractContent(msg)).toBe("foobar");
    });

    it("filters out thought chunks", () => {
        const msg = new AIMessage({
            content: [
                { type: "text", text: "visible" },
                { type: "text", text: "hidden", thought: true },
            ],
        });
        expect(extractContent(msg)).toBe("visible");
    });

    it("renders executableCode as a fenced code block", () => {
        const msg = new AIMessage({
            content: [{ type: "executableCode", executableCode: { language: "PYTHON", code: "print(1)" } }],
        });
        expect(extractContent(msg)).toBe("\n**Code:**\n```python\nprint(1)\n```\n");
    });

    it("renders executableCode with LANGUAGE_UNSPECIFIED as a plain fence", () => {
        const msg = new AIMessage({
            content: [{ type: "executableCode", executableCode: { language: "LANGUAGE_UNSPECIFIED", code: "x = 1" } }],
        });
        expect(extractContent(msg)).toBe("\n**Code:**\n```\nx = 1\n```\n");
    });

    it("omits executableCode block when code is empty", () => {
        const msg = new AIMessage({
            content: [{ type: "executableCode", executableCode: { language: "PYTHON", code: "   " } }],
        });
        expect(extractContent(msg)).toBe("");
    });

    it("renders codeExecutionResult with output", () => {
        const msg = new AIMessage({
            content: [
                {
                    type: "codeExecutionResult",
                    codeExecutionResult: { outcome: "OUTCOME_OK", output: "42\n" },
                },
            ],
        });
        expect(extractContent(msg)).toBe("\n**Code Output:**\n*Status: OUTCOME_OK*\n```\n42\n```\n");
    });

    it("omits codeExecutionResult block when output is empty", () => {
        const msg = new AIMessage({
            content: [{ type: "codeExecutionResult", codeExecutionResult: { outcome: "OUTCOME_OK", output: "" } }],
        });
        expect(extractContent(msg)).toBe("");
    });

    it("omits codeExecutionResult block when output is absent", () => {
        const msg = new AIMessage({
            content: [{ type: "codeExecutionResult", codeExecutionResult: { outcome: "OUTCOME_FAILED" } }],
        });
        expect(extractContent(msg)).toBe("");
    });

    it("interleaves text and code blocks preserving text whitespace", () => {
        const msg = new AIMessage({
            content: [
                { type: "text", text: "Here is the code:\n" },
                { type: "executableCode", executableCode: { language: "PYTHON", code: "print(1)" } },
                { type: "text", text: "And the output:\n" },
                { type: "codeExecutionResult", codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } },
            ],
        });
        expect(extractContent(msg)).toBe(
            "Here is the code:\n\n**Code:**\n```python\nprint(1)\n```\nAnd the output:\n\n**Code Output:**\n*Status: OUTCOME_OK*\n```\n1\n```\n",
        );
    });

    it("ignores non-extractable parts like tool_use", () => {
        const msg = new AIMessage({
            content: [
                { type: "text", text: "ok" },
                { type: "tool_use", id: "t1", name: "myTool", input: {} },
            ],
        });
        expect(extractContent(msg)).toBe("ok");
    });

    it("returns empty string for empty content array", () => {
        const msg = new AIMessage({ content: [] });
        expect(extractContent(msg)).toBe("");
    });
});

describe("extractInlineDataBlocksAsAttachments", () => {
    it("returns empty array when no messages have inlineData", () => {
        const messages = [new AIMessage("hello"), new HumanMessage("world")];
        expect(extractInlineDataBlocksAsAttachments(messages)).toEqual([]);
    });

    it("extracts a single inlineData part into a named Buffer attachment", () => {
        const data = Buffer.from("PNG_BYTES").toString("base64");
        const msg = new AIMessage({ content: [{ type: "inlineData", inlineData: { mimeType: "image/png", data } }] });
        const result = extractInlineDataBlocksAsAttachments([msg]);

        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("attachment-0.png");
        expect(result[0]?.attachment).toEqual(Buffer.from(data, "base64"));
    });

    it("extracts multiple inlineData parts across multiple messages in order", () => {
        const data1 = Buffer.from("IMG1").toString("base64");
        const data2 = Buffer.from("IMG2").toString("base64");
        const msg1 = new AIMessage({
            content: [{ type: "inlineData", inlineData: { mimeType: "image/png", data: data1 } }],
        });
        const msg2 = new AIMessage({
            content: [{ type: "inlineData", inlineData: { mimeType: "image/jpeg", data: data2 } }],
        });
        const result = extractInlineDataBlocksAsAttachments([msg1, msg2]);

        expect(result).toHaveLength(2);
        expect(result[0]?.name).toBe("attachment-0.png");
        expect(result[1]?.name).toBe("attachment-1.jpeg");
    });

    it("skips non-inlineData parts in array content", () => {
        const data = Buffer.from("X").toString("base64");
        const msg = new AIMessage({
            content: [
                { type: "text", text: "here" },
                { type: "inlineData", inlineData: { mimeType: "image/png", data } },
            ],
        });
        const result = extractInlineDataBlocksAsAttachments([msg]);

        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("attachment-0.png");
    });

    it("skips string-content messages", () => {
        const result = extractInlineDataBlocksAsAttachments([new AIMessage("plain string")]);
        expect(result).toHaveLength(0);
    });

    it("derives bin extension for unrecognized mime type", () => {
        const data = Buffer.from("X").toString("base64");
        const msg = new AIMessage({
            content: [{ type: "inlineData", inlineData: { mimeType: "application/octet-stream", data } }],
        });
        const result = extractInlineDataBlocksAsAttachments([msg]);

        expect(result[0]?.name).toBe("attachment-0.octet-stream");
    });
});

describe("replaceInlineDataBlocksWithDiscordTokenUrls", () => {
    const GUILD = "guild-1";
    const CHANNEL = "ch-1";
    const MSG_ID = "msg-1";

    it("returns string-content messages unchanged", () => {
        const msg = new AIMessage("plain");
        const result = replaceInlineDataBlocksWithDiscordTokenUrls([msg], [], MSG_ID, CHANNEL, GUILD);

        expect(result[0]).toBe(msg);
        expect(result[0]?.content).toBe("plain");
    });

    it("returns messages with no inlineData unchanged", () => {
        const msg = new AIMessage({ content: [{ type: "text", text: "hi" }] });
        const result = replaceInlineDataBlocksWithDiscordTokenUrls([msg], [], MSG_ID, CHANNEL, GUILD);

        expect(result[0]).toBe(msg);
    });

    it("replaces a single inlineData part with a media token block", () => {
        const data = Buffer.from("X").toString("base64");
        const msg = new AIMessage({ content: [{ type: "inlineData", inlineData: { mimeType: "image/png", data } }] });
        replaceInlineDataBlocksWithDiscordTokenUrls([msg], ["attach-99"], MSG_ID, CHANNEL, GUILD);

        expect(msg.content).toEqual([
            { type: "media", mimeType: "image/png", url: `discord://${GUILD}/${CHANNEL}/${MSG_ID}/attach-99` },
        ]);
    });

    it("replaces multiple inlineData parts across messages consuming attachment IDs in order", () => {
        const data = Buffer.from("X").toString("base64");
        const msg1 = new AIMessage({ content: [{ type: "inlineData", inlineData: { mimeType: "image/png", data } }] });
        const msg2 = new AIMessage({ content: [{ type: "inlineData", inlineData: { mimeType: "image/jpeg", data } }] });
        replaceInlineDataBlocksWithDiscordTokenUrls([msg1, msg2], ["id-0", "id-1"], MSG_ID, CHANNEL, GUILD);

        expect((msg1.content as unknown as { url: string }[])[0]?.url).toContain("id-0");
        expect((msg2.content as unknown as { url: string }[])[0]?.url).toContain("id-1");
    });

    it("preserves non-inlineData parts alongside replaced parts", () => {
        const data = Buffer.from("X").toString("base64");
        const msg = new AIMessage({
            content: [
                { type: "text", text: "before" },
                { type: "inlineData", inlineData: { mimeType: "image/png", data } },
                { type: "text", text: "after" },
            ],
        });
        replaceInlineDataBlocksWithDiscordTokenUrls([msg], ["attach-1"], MSG_ID, CHANNEL, GUILD);

        const content = msg.content as unknown as { type: string; text?: string; mimeType?: string; url?: string }[];
        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({ type: "text", text: "before" });
        expect(content[1]).toEqual({
            type: "media",
            mimeType: "image/png",
            url: `discord://${GUILD}/${CHANNEL}/${MSG_ID}/attach-1`,
        });
        expect(content[2]).toEqual({ type: "text", text: "after" });
    });

    it("throws AppError when attachment IDs are exhausted before inlineData parts", () => {
        const data = Buffer.from("X").toString("base64");
        const msg = new AIMessage({
            content: [
                { type: "inlineData", inlineData: { mimeType: "image/png", data } },
                { type: "inlineData", inlineData: { mimeType: "image/png", data } },
            ],
        });

        expect(() =>
            replaceInlineDataBlocksWithDiscordTokenUrls([msg], ["only-one-id"], MSG_ID, CHANNEL, GUILD),
        ).toThrow(AppError);
    });
});

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
