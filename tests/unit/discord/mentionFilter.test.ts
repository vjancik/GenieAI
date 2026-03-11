import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { MessageType } from "discord.js";
import { MessageIntent } from "../../../src/domain/message/MessageIntent.ts";
import {
    extractUserContent,
    isExplicitMention,
    parseMessageIntent,
} from "../../../src/infrastructure/discord/DiscordGateway.ts";

const BOT_ID = "123456789";
const OTHER_USER_ID = "987654321";

/**
 * Creates a minimal Message mock with just the fields needed by the filter functions.
 */
function makeMessage(opts: {
    mentionsBotId?: string;
    repliedUserId?: string | null;
    type?: MessageType;
    content?: string;
}): Message {
    const repliedUser = opts.repliedUserId ? { id: opts.repliedUserId } : null;
    return {
        mentions: {
            users: {
                has: (id: string) => id === opts.mentionsBotId,
            },
            repliedUser,
            /**
             * Mirrors discord.js MessageMentions.has() with ignoreRepliedUser support.
             * When ignoreRepliedUser is true, returns false if the user is only mentioned
             * via the reply-mention mechanism (i.e., repliedUser.id === id).
             */
            has: (id: string, options?: { ignoreRepliedUser?: boolean }) => {
                if (id !== opts.mentionsBotId) return false;
                if (options?.ignoreRepliedUser && repliedUser?.id === id) return false;
                return true;
            },
        },
        type: opts.type ?? MessageType.Default,
        content: opts.content ?? "",
    } as unknown as Message;
}

describe("isExplicitMention", () => {
    test("returns true when bot is explicitly @mentioned", () => {
        const msg = makeMessage({
            mentionsBotId: BOT_ID,
            type: MessageType.Default,
        });
        expect(isExplicitMention(msg, BOT_ID)).toBe(true);
    });

    test("returns false when bot is not in mentions at all", () => {
        const msg = makeMessage({ mentionsBotId: OTHER_USER_ID });
        expect(isExplicitMention(msg, BOT_ID)).toBe(false);
    });

    test("returns false for reply-mention (Reply type + repliedUser is the bot)", () => {
        // This simulates Discord's reply-with-mention: the bot is in mentions,
        // the message type is Reply, and repliedUser is the bot
        const msg = makeMessage({
            mentionsBotId: BOT_ID,
            repliedUserId: BOT_ID,
            type: MessageType.Reply,
        });
        expect(isExplicitMention(msg, BOT_ID)).toBe(false);
    });

    test("returns true when replying to another user but also explicitly mentioning the bot", () => {
        // User replies to someone else AND also types @bot — this IS an explicit mention
        const msg = makeMessage({
            mentionsBotId: BOT_ID,
            repliedUserId: OTHER_USER_ID,
            type: MessageType.Reply,
        });
        expect(isExplicitMention(msg, BOT_ID)).toBe(true);
    });

    test("returns true for Reply type when repliedUser is null (mention without reply notification)", () => {
        const msg = makeMessage({
            mentionsBotId: BOT_ID,
            repliedUserId: null,
            type: MessageType.Reply,
        });
        expect(isExplicitMention(msg, BOT_ID)).toBe(true);
    });
});

describe("parseMessageIntent", () => {
    test("returns GENERAL for !ai command", () => {
        expect(parseMessageIntent("!ai what is the weather?")).toBe(MessageIntent.GENERAL);
    });

    test("returns SEARCH for !aisearch command", () => {
        expect(parseMessageIntent("!aisearch latest news")).toBe(MessageIntent.SEARCH);
    });

    test("returns SUMMARY for !aisummary command", () => {
        expect(parseMessageIntent("!aisummary summarize this")).toBe(MessageIntent.SUMMARY);
    });

    test("returns UNKNOWN when no command prefix", () => {
        expect(parseMessageIntent("just a regular message")).toBe(MessageIntent.UNKNOWN);
    });

    test("returns UNKNOWN for empty string", () => {
        expect(parseMessageIntent("")).toBe(MessageIntent.UNKNOWN);
    });

    test("is case-insensitive: !AI", () => {
        expect(parseMessageIntent("!AI hello")).toBe(MessageIntent.GENERAL);
    });

    test("is case-insensitive: !AiSearch", () => {
        expect(parseMessageIntent("!AiSearch query")).toBe(MessageIntent.SEARCH);
    });

    test("is case-insensitive: !AISUMMARY", () => {
        expect(parseMessageIntent("!AISUMMARY text")).toBe(MessageIntent.SUMMARY);
    });

    test("does not match !ai without trailing whitespace", () => {
        expect(parseMessageIntent("!aiquery")).toBe(MessageIntent.UNKNOWN);
    });

    test("does not match !aisearch if not at start of string", () => {
        expect(parseMessageIntent("hey !aisearch something")).toBe(MessageIntent.UNKNOWN);
    });

    test("!aisearch is not shadowed by !ai prefix", () => {
        // !ai must not match the beginning of !aisearch
        expect(parseMessageIntent("!aisearch find this")).toBe(MessageIntent.SEARCH);
    });
});

describe("extractUserContent", () => {
    test("strips <@userId> mention format", () => {
        const msg = makeMessage({ content: `<@${BOT_ID}> hello there` });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("hello there");
    });

    test("strips <@!userId> legacy nickname mention format", () => {
        const msg = makeMessage({ content: `<@!${BOT_ID}> what is 2+2?` });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("what is 2+2?");
    });

    test("strips multiple bot mentions", () => {
        const msg = makeMessage({
            content: `<@${BOT_ID}> hey <@${BOT_ID}> test`,
        });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("hey  test");
    });

    test("trims surrounding whitespace", () => {
        const msg = makeMessage({
            content: `  <@${BOT_ID}>   tell me a joke   `,
        });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("tell me a joke");
    });

    test("returns empty string when only a mention is present", () => {
        const msg = makeMessage({ content: `<@${BOT_ID}>` });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("");
    });

    test("does not strip other users' mentions", () => {
        const msg = makeMessage({
            content: `<@${BOT_ID}> hey <@${OTHER_USER_ID}> what do you think?`,
        });
        expect(extractUserContent(msg, BOT_ID, null)).toBe(`hey <@${OTHER_USER_ID}> what do you think?`);
    });

    test("strips the bot's role mention (<@&roleId>) when botRoleId is provided", () => {
        const BOT_ROLE_ID = "111222333";
        const msg = makeMessage({
            content: `<@&${BOT_ROLE_ID}> <@${BOT_ID}> what is 2+2?`,
        });
        expect(extractUserContent(msg, BOT_ID, BOT_ROLE_ID)).toBe("what is 2+2?");
    });

    test("does not strip other role mentions when botRoleId is provided", () => {
        const BOT_ROLE_ID = "111222333";
        const OTHER_ROLE_ID = "999888777";
        const msg = makeMessage({
            content: `<@&${OTHER_ROLE_ID}> <@${BOT_ID}> what is 2+2?`,
        });
        expect(extractUserContent(msg, BOT_ID, BOT_ROLE_ID)).toBe(`<@&${OTHER_ROLE_ID}>  what is 2+2?`);
    });

    test("does not strip role mentions when botRoleId is null (DM)", () => {
        const msg = makeMessage({
            content: `<@&111222333> <@${BOT_ID}> what is 2+2?`,
        });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("<@&111222333>  what is 2+2?");
    });

    test("strips !ai command prefix", () => {
        const msg = makeMessage({ content: "!ai tell me a joke" });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("tell me a joke");
    });

    test("strips !aisearch command prefix", () => {
        const msg = makeMessage({ content: "!aisearch latest news" });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("latest news");
    });

    test("strips !aisummary command prefix", () => {
        const msg = makeMessage({ content: "!aisummary this article" });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("this article");
    });

    test("strips command prefix case-insensitively", () => {
        const msg = makeMessage({ content: "!AI what is TypeScript?" });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("what is TypeScript?");
    });

    test("strips command prefix when it appears before a bot mention", () => {
        const msg = makeMessage({ content: `!aisearch <@${BOT_ID}> find something` });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("find something");
    });

    test("does not strip command prefix without trailing whitespace", () => {
        const msg = makeMessage({ content: "!aiquery something" });
        expect(extractUserContent(msg, BOT_ID, null)).toBe("!aiquery something");
    });
});
