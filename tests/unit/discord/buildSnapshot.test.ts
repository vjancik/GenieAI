import { describe, expect, it } from "bun:test";
import type {
    IChatClientMessage,
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
    IChatClientMessageSnapshot,
} from "../../../src/application/ports/chat/IChatClientMessage.ts";
import { buildSnapshot } from "../../../src/infrastructure/discord/messageExtractors.ts";

const BASE_DATE = new Date("2024-06-01T12:00:00Z");

/** Minimal attachment stub. */
function makeAttachment(id: string): IChatClientMessageAttachment {
    return {
        id,
        url: `https://cdn.example.com/${id}`,
        proxyURL: `https://proxy.example.com/${id}`,
        name: `${id}.png`,
        size: 512,
        contentType: "image/png",
    };
}

/** Minimal embed stub. */
function _makeEmbed(): IChatClientMessageEmbed {
    return {
        type: "rich",
        title: "Test Embed",
        description: null,
        author: null,
        provider: null,
        timestamp: null,
        footer: null,
        fields: [],
        video: null,
        image: null,
        thumbnail: null,
    };
}

/** Build a minimal IChatClientMessage mock with the given overrides. */
function makeMessage(overrides: Partial<IChatClientMessage> & Pick<IChatClientMessage, "id">): IChatClientMessage {
    return {
        id: overrides.id,
        channelId: overrides.channelId ?? "channel-1",
        guildId: overrides.guildId !== undefined ? overrides.guildId : "guild-1",
        authorId: overrides.authorId ?? "user-1",
        authorUsername: overrides.authorUsername ?? "testuser",
        authorDisplayName: overrides.authorDisplayName ?? "Test User",
        isAuthorBot: overrides.isAuthorBot ?? false,
        createdAt: overrides.createdAt ?? BASE_DATE,
        content: overrides.content ?? "Hello",
        cleanContent: overrides.cleanContent ?? "Hello",
        buttons: overrides.buttons ?? [],
        attachments: overrides.attachments ?? [],
        embeds: overrides.embeds ?? [],
        referencedMessageId: overrides.referencedMessageId !== undefined ? overrides.referencedMessageId : null,
        isForwarded: overrides.isForwarded ?? false,
        forwardedSnapshot: overrides.forwardedSnapshot ?? null,
        botRoleId: overrides.botRoleId ?? null,
        hasExplicitMention: overrides.hasExplicitMention ?? ((_id) => false),
        reply: overrides.reply ?? (() => Promise.reject(new Error("not implemented"))),
        edit: overrides.edit ?? (() => Promise.reject(new Error("not implemented"))),
        delete: overrides.delete ?? (() => Promise.reject(new Error("not implemented"))),
    };
}

/** Build a minimal IChatClientMessageSnapshot stub. */
function makeForwardedSnapshot(id: string, channelId: string): IChatClientMessageSnapshot {
    return {
        id,
        content: "Forwarded content",
        cleanContent: "Forwarded content",
        attachments: [makeAttachment("fwd-att-1")],
        embeds: [],
        channelId,
    };
}

const BOT_ID = "bot-user-1";
const PREV_BOT_ID = "old-bot-1";

describe("buildSnapshot", () => {
    // 1
    it("maps all IChatClientMessage fields to the snapshot", () => {
        const msg = makeMessage({
            id: "msg-1",
            channelId: "ch-1",
            guildId: "guild-1",
            authorId: "user-1",
            authorUsername: "alice",
            authorDisplayName: "Alice",
            isAuthorBot: false,
            createdAt: BASE_DATE,
            content: "Hi there",
            attachments: [],
            embeds: [],
            referencedMessageId: null,
        });

        const snap = buildSnapshot(msg, BOT_ID, undefined);

        expect(snap.id).toBe("msg-1");
        expect(snap.channelId).toBe("ch-1");
        expect(snap.guildId).toBe("guild-1");
        expect(snap.authorId).toBe("user-1");
        expect(snap.authorUsername).toBe("alice");
        expect(snap.authorDisplayName).toBe("Alice");
        expect(snap.isBot).toBe(false);
        expect(snap.createdAt).toBe(BASE_DATE);
        expect(snap.content).toBe("Hi there");
        expect(snap.referencedMessageId).toBeNull();
    });

    // 2
    it("uses '@me' sentinel for DM messages (guildId null)", () => {
        const msg = makeMessage({ id: "msg-1", guildId: null });
        const snap = buildSnapshot(msg, BOT_ID, undefined);
        expect(snap.guildId).toBe("@me");
    });

    // 3
    it("sets isOwnBot true when authorId matches botUserId", () => {
        const msg = makeMessage({ id: "msg-1", authorId: BOT_ID, isAuthorBot: true });
        const snap = buildSnapshot(msg, BOT_ID, undefined);
        expect(snap.isOwnBot).toBe(true);
    });

    // 4
    it("sets isOwnBot true when authorId matches previousBotId", () => {
        const msg = makeMessage({ id: "msg-1", authorId: PREV_BOT_ID, isAuthorBot: true });
        const snap = buildSnapshot(msg, BOT_ID, PREV_BOT_ID);
        expect(snap.isOwnBot).toBe(true);
    });

    // 5
    it("sets isOwnBot false for regular user messages", () => {
        const msg = makeMessage({ id: "msg-1", authorId: "some-other-user" });
        const snap = buildSnapshot(msg, BOT_ID, PREV_BOT_ID);
        expect(snap.isOwnBot).toBe(false);
    });

    // 6
    it("forwarded with snapshot: isForwarded, null referencedMessageId, nested snapshot in messageSnapshots", () => {
        const fwdSnap = makeForwardedSnapshot("src-msg-1", "src-ch-1");
        const msg = makeMessage({
            id: "msg-1",
            isForwarded: true,
            forwardedSnapshot: fwdSnap,
            referencedMessageId: null,
            attachments: [],
        });

        const snap = buildSnapshot(msg, BOT_ID, undefined);

        expect(snap.isForwarded).toBe(true);
        expect(snap.referencedMessageId).toBeNull();
        expect(snap.messageSnapshots).toHaveLength(1);
        expect(snap.messageSnapshots?.[0]?.content).toBe("Forwarded content");
        expect(snap.messageSnapshots?.[0]?.id).toBe("src-msg-1");
        expect(snap.messageSnapshots?.[0]?.channelId).toBe("src-ch-1");
        // Outer attachments mirror forwarded snapshot attachments
        expect(snap.attachments).toHaveLength(1);
        expect(snap.attachments[0]?.id).toBe("fwd-att-1");
    });

    // 7
    it("forwarded with no matching snapshot: isForwarded true, empty content and attachments, nested id is empty string", () => {
        const msg = makeMessage({
            id: "msg-1",
            isForwarded: true,
            forwardedSnapshot: null,
            referencedMessageId: null,
        });

        const snap = buildSnapshot(msg, BOT_ID, undefined);

        expect(snap.isForwarded).toBe(true);
        expect(snap.referencedMessageId).toBeNull();
        expect(snap.content).toBe("");
        expect(snap.attachments).toHaveLength(0);
        expect(snap.messageSnapshots).toHaveLength(1);
        expect(snap.messageSnapshots?.[0]?.id).toBe("");
        expect(snap.messageSnapshots?.[0]?.content).toBe("");
    });

    // 8
    it("non-forwarded with reply: propagates referencedMessageId", () => {
        const msg = makeMessage({ id: "msg-2", referencedMessageId: "msg-1" });
        const snap = buildSnapshot(msg, BOT_ID, undefined);
        expect(snap.referencedMessageId).toBe("msg-1");
        expect(snap.isForwarded).toBeFalsy();
    });
});
