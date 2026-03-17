import { describe, expect, mock, test } from "bun:test";
import type { Collection, Message, TextChannel } from "discord.js";
import { MessageReferenceType } from "discord.js";
import pino from "pino";
import { DiscordChatMessageService } from "../../../src/infrastructure/discord/DiscordChatMessageService.ts";
import type { DiscordClient } from "../../../src/infrastructure/discord/DiscordClient.ts";

const testLogger = pino({ level: "silent" });

const BOT_USER_ID = "bot-user-id";
const PREVIOUS_BOT_ID = "old-bot-id";
const CHANNEL_ID = "channel-123";

/** Minimal embed shape matching discord.js Embed getters used by extractEmbeds. */
type MockEmbed = {
    data: { type?: string };
    title: string | null;
    description: string | null;
    author: { name: string } | null;
    provider: { name?: string } | null;
    timestamp: string | null;
    footer: { text: string } | null;
    fields: Array<{ name: string; value: string }>;
    video: { url?: string; proxyURL?: string } | null;
    image: { url: string; proxyURL?: string } | null;
    thumbnail: { url: string; proxyURL?: string } | null;
};

/** Minimal MessageSnapshot shape for forwarded message tests. */
type MockMessageSnapshot = {
    content: string;
    cleanContent: string | null;
    embeds: MockEmbed[];
    attachments: { values: () => IterableIterator<unknown> };
};

/** Build a minimal discord.js Message-shaped object for testing. */
function makeMessage(overrides: {
    id: string;
    content?: string;
    authorId?: string;
    authorUsername?: string;
    authorDisplayName?: string;
    isBot?: boolean;
    referenceMessageId?: string;
    referenceChannelId?: string;
    referenceType?: MessageReferenceType;
    guildId?: string | null;
    attachments?: unknown[];
    embeds?: MockEmbed[];
    messageSnapshots?: Map<string, MockMessageSnapshot>;
}): Message {
    const attachmentEntries = (overrides.attachments ?? []) as Array<{
        id: string;
        url: string;
        proxyURL: string;
        name: string;
        size: number;
        contentType: string | null;
    }>;
    // Minimal Collection-like structure for attachments
    const attachmentsCollection = {
        values: () => attachmentEntries.values(),
    } as unknown as Collection<string, Message["attachments"] extends Collection<string, infer V> ? V : never>;

    const reference = overrides.referenceMessageId
        ? {
              messageId: overrides.referenceMessageId,
              channelId: overrides.referenceChannelId ?? CHANNEL_ID,
              type: overrides.referenceType ?? MessageReferenceType.Default,
          }
        : null;

    return {
        id: overrides.id,
        content: overrides.content ?? "Hello",
        channelId: CHANNEL_ID,
        guildId: overrides.guildId !== undefined ? overrides.guildId : "guild-1",
        createdAt: new Date("2024-01-01T00:00:00Z"),
        author: {
            id: overrides.authorId ?? "user-1",
            username: overrides.authorUsername ?? "testuser",
            displayName: overrides.authorDisplayName ?? "Test User",
            bot: overrides.isBot ?? false,
        },
        member: null,
        reference,
        attachments: attachmentsCollection,
        embeds: overrides.embeds ?? [],
        messageSnapshots: overrides.messageSnapshots ?? new Map(),
    } as unknown as Message;
}

/**
 * Build a mock DiscordClient that resolves a channel which can fetch messages by ID.
 */
function makeDiscordClient(messagesById: Map<string, Message>, userId: string = BOT_USER_ID): DiscordClient {
    const channel = {
        isTextBased: () => true,
        messages: {
            fetch: mock(async (id: string) => {
                const msg = messagesById.get(id);
                if (!msg) throw new Error(`Message ${id} not found`);
                return msg;
            }),
        },
    } as unknown as TextChannel;

    return {
        client: {
            user: { id: userId },
            channels: {
                fetch: mock(async () => channel),
            },
        },
    } as unknown as DiscordClient;
}

/** Build a DiscordClient whose channel fetch throws. */
function makeFailingDiscordClient(): DiscordClient {
    return {
        client: {
            user: { id: BOT_USER_ID },
            channels: {
                fetch: mock(async () => {
                    throw new Error("Channel not found");
                }),
            },
        },
    } as unknown as DiscordClient;
}

describe("DiscordChatMessageService.fetchChain", () => {
    test("returns empty array when channel fetch fails", async () => {
        const service = new DiscordChatMessageService(makeFailingDiscordClient(), undefined, testLogger);
        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });
        expect(result).toEqual([]);
    });

    test("returns empty array when channel is not text-based", async () => {
        const discordClient = {
            client: {
                user: { id: BOT_USER_ID },
                channels: {
                    fetch: mock(async () => ({ isTextBased: () => false })),
                },
            },
        } as unknown as DiscordClient;

        const service = new DiscordChatMessageService(discordClient, undefined, testLogger);
        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });
        expect(result).toEqual([]);
    });

    test("returns single snapshot for a root message (no reference)", async () => {
        const msg = makeMessage({ id: "msg-1", content: "Root message" });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("msg-1");
        expect(result[0]?.content).toBe("Root message");
        expect(result[0]?.referencedMessageId).toBeNull();
    });

    test("returns two-message chain in chronological order (root first)", async () => {
        const root = makeMessage({ id: "msg-1", content: "Root" });
        const child = makeMessage({ id: "msg-2", content: "Reply", referenceMessageId: "msg-1" });
        const client = makeDiscordClient(
            new Map([
                ["msg-1", root],
                ["msg-2", child],
            ]),
        );
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-2",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result).toHaveLength(2);
        expect(result[0]?.id).toBe("msg-1");
        expect(result[1]?.id).toBe("msg-2");
    });

    test("stops at limit and returns partial chain", async () => {
        const msg1 = makeMessage({ id: "msg-1", content: "Root" });
        const msg2 = makeMessage({ id: "msg-2", content: "Middle", referenceMessageId: "msg-1" });
        const msg3 = makeMessage({ id: "msg-3", content: "Latest", referenceMessageId: "msg-2" });
        const client = makeDiscordClient(
            new Map([
                ["msg-1", msg1],
                ["msg-2", msg2],
                ["msg-3", msg3],
            ]),
        );
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-3",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
            limit: 2,
        });

        expect(result).toHaveLength(2);
        // Should contain msg-2 and msg-3 (limit reached before walking to msg-1)
        expect(result[0]?.id).toBe("msg-2");
        expect(result[1]?.id).toBe("msg-3");
    });

    test("isOwnBot is true when authorId matches discordClient.userId", async () => {
        const msg = makeMessage({ id: "msg-1", authorId: BOT_USER_ID, isBot: true });
        const client = makeDiscordClient(new Map([["msg-1", msg]]), BOT_USER_ID);
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result[0]?.isOwnBot).toBe(true);
        expect(result[0]?.isBot).toBe(true);
    });

    test("isOwnBot is true when authorId matches previousBotId", async () => {
        const msg = makeMessage({ id: "msg-1", authorId: PREVIOUS_BOT_ID, isBot: true });
        const client = makeDiscordClient(new Map([["msg-1", msg]]), BOT_USER_ID);
        const service = new DiscordChatMessageService(client, PREVIOUS_BOT_ID, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result[0]?.isOwnBot).toBe(true);
    });

    test("isOwnBot is false for regular user messages", async () => {
        const msg = makeMessage({ id: "msg-1", authorId: "some-user", isBot: false });
        const client = makeDiscordClient(new Map([["msg-1", msg]]), BOT_USER_ID);
        const service = new DiscordChatMessageService(client, PREVIOUS_BOT_ID, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result[0]?.isOwnBot).toBe(false);
    });

    test("maps null guildId to '@me' for DMs", async () => {
        const msg = makeMessage({ id: "msg-1", guildId: null });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "@me",
        });

        expect(result[0]?.guildId).toBe("@me");
    });

    test("returns partial chain when mid-chain fetch fails", async () => {
        const msg2 = makeMessage({ id: "msg-2", content: "Child", referenceMessageId: "msg-1" });
        // Only msg-2 is in the map; fetching msg-1 will throw
        const client = makeDiscordClient(new Map([["msg-2", msg2]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-2",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        // msg-2 was fetched successfully before the parent fetch failed
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("msg-2");
    });

    test("maps attachment fields correctly", async () => {
        const msg = makeMessage({
            id: "msg-1",
            attachments: [
                {
                    id: "att-1",
                    url: "https://cdn.discord.com/file.png",
                    proxyURL: "https://proxy/file.png",
                    name: "file.png",
                    size: 1024,
                    contentType: "image/png",
                },
            ],
        });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result[0]?.attachments).toHaveLength(1);
        expect(result[0]?.attachments[0]?.id).toBe("att-1");
        expect(result[0]?.attachments[0]?.contentType).toBe("image/png");
    });

    test("maps embeds to DiscordEmbedInfo", async () => {
        const msg = makeMessage({
            id: "msg-1",
            embeds: [
                {
                    data: { type: "rich" },
                    title: "Embed Title",
                    description: "Embed Description",
                    author: { name: "Embed Author" },
                    provider: { name: "Embed Provider" },
                    timestamp: null,
                    footer: null,
                    fields: [],
                    video: null,
                    image: null,
                    thumbnail: null,
                },
            ],
        });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result[0]?.embeds).toHaveLength(1);
        expect(result[0]?.embeds?.[0]?.type).toBe("rich");
        expect(result[0]?.embeds?.[0]?.title).toBe("Embed Title");
        expect(result[0]?.embeds?.[0]?.description).toBe("Embed Description");
        expect(result[0]?.embeds?.[0]?.author?.name).toBe("Embed Author");
        expect(result[0]?.embeds?.[0]?.provider?.name).toBe("Embed Provider");
    });

    test("omits embeds field when message has no embeds", async () => {
        const msg = makeMessage({ id: "msg-1" });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result[0]?.embeds).toBeUndefined();
    });

    test("forwarded message: sets isForwarded, uses snapshot content, referencedMessageId is null", async () => {
        const fwdSnapshot: MockMessageSnapshot = {
            content: "Original forwarded text",
            cleanContent: "Original forwarded text",
            embeds: [],
            attachments: { values: () => [].values() },
        };
        const msg = makeMessage({
            id: "msg-1",
            content: "",
            referenceMessageId: "original-msg-id",
            referenceChannelId: "other-channel",
            referenceType: MessageReferenceType.Forward,
            messageSnapshots: new Map([["original-msg-id", fwdSnapshot]]),
        });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result).toHaveLength(1);
        expect(result[0]?.isForwarded).toBe(true);
        expect(result[0]?.referencedMessageId).toBeNull();
        expect(result[0]?.messageSnapshots?.[0]?.content).toBe("Original forwarded text");
    });

    test("forwarded message terminates chain traversal", async () => {
        const fwdSnapshot: MockMessageSnapshot = {
            content: "fwd content",
            cleanContent: "fwd content",
            embeds: [],
            attachments: { values: () => [].values() },
        };
        const root = makeMessage({ id: "msg-1", content: "Root" });
        const fwd = makeMessage({
            id: "msg-2",
            content: "",
            referenceMessageId: "msg-1",
            referenceChannelId: "other-channel",
            referenceType: MessageReferenceType.Forward,
            messageSnapshots: new Map([["msg-1", fwdSnapshot]]),
        });
        const client = makeDiscordClient(
            new Map([
                ["msg-1", root],
                ["msg-2", fwd],
            ]),
        );
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-2",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        // Chain stops at the forward — msg-1 is not fetched as a separate entry
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("msg-2");
        expect(result[0]?.isForwarded).toBe(true);
    });

    test("forwarded message with no matching snapshot falls back gracefully", async () => {
        const msg = makeMessage({
            id: "msg-1",
            content: "",
            referenceMessageId: "missing-id",
            referenceChannelId: "other-channel",
            referenceType: MessageReferenceType.Forward,
            messageSnapshots: new Map(),
        });
        const client = makeDiscordClient(new Map([["msg-1", msg]]));
        const service = new DiscordChatMessageService(client, undefined, testLogger);

        const result = await service.fetchChain({
            startDiscordMessageId: "msg-1",
            channelId: CHANNEL_ID,
            guildId: "guild-1",
        });

        expect(result).toHaveLength(1);
        expect(result[0]?.isForwarded).toBe(true);
        expect(result[0]?.messageSnapshots?.[0]?.content).toBe("");
    });
});
