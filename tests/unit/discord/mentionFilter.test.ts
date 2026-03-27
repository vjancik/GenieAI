import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { MessageType } from "discord.js";
import { extractUserContent } from "../../../src/application/helpers/extractUserContent.ts";
import { parseMessageIntent } from "../../../src/application/helpers/parseMessageIntent.ts";
import { MessageIntent } from "../../../src/domain/value-objects/MessageIntent.ts";
import { DiscordClientMessage } from "../../../src/infrastructure/discord/adapters/DiscordClientMessage.ts";

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
        attachments: { values: () => [].values() },
        embeds: [],
        components: [],
    } as unknown as Message;
}

describe("DiscordClientMessage.hasExplicitMention", () => {
    test("returns true when bot is explicitly @mentioned", () => {
        const msg = new DiscordClientMessage(makeMessage({ mentionsBotId: BOT_ID, type: MessageType.Default }));
        expect(msg.hasExplicitMention(BOT_ID)).toBe(true);
    });

    test("returns false when bot is not in mentions at all", () => {
        const msg = new DiscordClientMessage(makeMessage({ mentionsBotId: OTHER_USER_ID }));
        expect(msg.hasExplicitMention(BOT_ID)).toBe(false);
    });

    test("returns false for reply-mention (Reply type + repliedUser is the bot)", () => {
        // This simulates Discord's reply-with-mention: the bot is in mentions,
        // the message type is Reply, and repliedUser is the bot
        const msg = new DiscordClientMessage(
            makeMessage({ mentionsBotId: BOT_ID, repliedUserId: BOT_ID, type: MessageType.Reply }),
        );
        expect(msg.hasExplicitMention(BOT_ID)).toBe(false);
    });

    test("returns true when replying to another user but also explicitly mentioning the bot", () => {
        // User replies to someone else AND also types @bot — this IS an explicit mention
        const msg = new DiscordClientMessage(
            makeMessage({ mentionsBotId: BOT_ID, repliedUserId: OTHER_USER_ID, type: MessageType.Reply }),
        );
        expect(msg.hasExplicitMention(BOT_ID)).toBe(true);
    });

    test("returns true for Reply type when repliedUser is null (mention without reply notification)", () => {
        const msg = new DiscordClientMessage(
            makeMessage({ mentionsBotId: BOT_ID, repliedUserId: null, type: MessageType.Reply }),
        );
        expect(msg.hasExplicitMention(BOT_ID)).toBe(true);
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
        expect(extractUserContent(`<@${BOT_ID}> hello there`, BOT_ID, null)).toBe("hello there");
    });

    test("strips <@!userId> legacy nickname mention format", () => {
        expect(extractUserContent(`<@!${BOT_ID}> what is 2+2?`, BOT_ID, null)).toBe("what is 2+2?");
    });

    test("strips multiple bot mentions", () => {
        expect(extractUserContent(`<@${BOT_ID}> hey <@${BOT_ID}> test`, BOT_ID, null)).toBe("hey  test");
    });

    test("trims surrounding whitespace", () => {
        expect(extractUserContent(`  <@${BOT_ID}>   tell me a joke   `, BOT_ID, null)).toBe("tell me a joke");
    });

    test("returns empty string when only a mention is present", () => {
        expect(extractUserContent(`<@${BOT_ID}>`, BOT_ID, null)).toBe("");
    });

    test("does not strip other users' mentions", () => {
        expect(extractUserContent(`<@${BOT_ID}> hey <@${OTHER_USER_ID}> what do you think?`, BOT_ID, null)).toBe(
            `hey <@${OTHER_USER_ID}> what do you think?`,
        );
    });

    test("strips the bot's role mention (<@&roleId>) when botRoleId is provided", () => {
        const BOT_ROLE_ID = "111222333";
        expect(extractUserContent(`<@&${BOT_ROLE_ID}> <@${BOT_ID}> what is 2+2?`, BOT_ID, BOT_ROLE_ID)).toBe(
            "what is 2+2?",
        );
    });

    test("does not strip other role mentions when botRoleId is provided", () => {
        const BOT_ROLE_ID = "111222333";
        const OTHER_ROLE_ID = "999888777";
        expect(extractUserContent(`<@&${OTHER_ROLE_ID}> <@${BOT_ID}> what is 2+2?`, BOT_ID, BOT_ROLE_ID)).toBe(
            `<@&${OTHER_ROLE_ID}>  what is 2+2?`,
        );
    });

    test("does not strip role mentions when botRoleId is null (DM)", () => {
        expect(extractUserContent(`<@&111222333> <@${BOT_ID}> what is 2+2?`, BOT_ID, null)).toBe(
            "<@&111222333>  what is 2+2?",
        );
    });

    test("strips !ai command prefix", () => {
        expect(extractUserContent("!ai tell me a joke", BOT_ID, null)).toBe("tell me a joke");
    });

    test("strips !aisearch command prefix", () => {
        expect(extractUserContent("!aisearch latest news", BOT_ID, null)).toBe("latest news");
    });

    test("strips !aisummary command prefix", () => {
        expect(extractUserContent("!aisummary this article", BOT_ID, null)).toBe("this article");
    });

    test("strips command prefix case-insensitively", () => {
        expect(extractUserContent("!AI what is TypeScript?", BOT_ID, null)).toBe("what is TypeScript?");
    });

    test("strips command prefix when it appears before a bot mention", () => {
        expect(extractUserContent(`!aisearch <@${BOT_ID}> find something`, BOT_ID, null)).toBe("find something");
    });

    test("does not strip command prefix without trailing whitespace", () => {
        expect(extractUserContent("!aiquery something", BOT_ID, null)).toBe("!aiquery something");
    });
});
