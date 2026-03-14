import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { sql } from "drizzle-orm";
import pino from "pino";
import { DatabaseError } from "../../../src/domain/errors/AppError.ts";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import type { MessagePage } from "../../../src/domain/message/MessagePage.ts";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { PgMessagePageRepository } from "../../../src/infrastructure/db/repositories/PgMessagePageRepository.ts";
import { PgMessageRepository } from "../../../src/infrastructure/db/repositories/PgMessageRepository.ts";

/**
 * Integration tests for PgMessagePageRepository.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_URL env var set to the test DB connection string
 *
 * Each test inserts a parent messages row first (required by the FK on message_pages.bot_discord_message_id),
 * then exercises the page repository.
 */

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgresql://genie_test:genie_test@localhost:5433/genie_test";

const testLogger = pino({ level: "silent" });

let db: ReturnType<typeof createDb>;
let messageRepo: PgMessageRepository;
let pageRepo: PgMessagePageRepository;

beforeAll(async () => {
    db = createDb(TEST_DB_URL);
    messageRepo = new PgMessageRepository(db, testLogger);
    pageRepo = new PgMessagePageRepository(db, testLogger);
});

afterEach(async () => {
    // CASCADE deletes message_pages rows too
    await db.execute(sql`TRUNCATE TABLE messages RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
});

/** Insert a messages row so the FK constraint on message_pages is satisfied. */
async function saveParentMessage(discordMessageId: string): Promise<DiscordMessage> {
    return messageRepo.save({
        discordMessageId,
        repliesToDiscordId: null,
        channelId: "ch-001",
        guildId: "guild-001",
        role: "assistant",
        langchainMessages: [new HumanMessage("stub").toJSON() as unknown as Record<string, unknown>],
    });
}

function pagePayload(
    botDiscordMessageId: string,
    overrides: Partial<Omit<MessagePage, "id" | "createdAt" | "botDiscordMessageId">> = {},
): Omit<MessagePage, "id" | "createdAt"> {
    return {
        botDiscordMessageId,
        endOffset: 1800,
        currentPage: 1,
        totalPages: 3,
        ...overrides,
    };
}

describe("PgMessagePageRepository.save", () => {
    test("saves a page and returns it with generated id and createdAt", async () => {
        const parent = await saveParentMessage("bot-save-001");
        const payload = pagePayload(parent.discordMessageId);

        const saved = await pageRepo.save(payload);

        expect(saved.id).toBeDefined();
        expect(typeof saved.id).toBe("string");
        expect(saved.botDiscordMessageId).toBe("bot-save-001");
        expect(saved.endOffset).toBe(1800);
        expect(saved.currentPage).toBe(1);
        expect(saved.totalPages).toBe(3);
        expect(saved.createdAt).toBeInstanceOf(Date);
    });

    test("throws DatabaseError on duplicate botDiscordMessageId", async () => {
        const parent = await saveParentMessage("bot-dup-001");
        const payload = pagePayload(parent.discordMessageId);

        await pageRepo.save(payload);

        expect(pageRepo.save(payload)).rejects.toBeInstanceOf(DatabaseError);
    });

    test("saves page with endOffset=0 (start of page 2 is beginning of text)", async () => {
        const parent = await saveParentMessage("bot-offset-zero");
        const saved = await pageRepo.save(pagePayload(parent.discordMessageId, { endOffset: 0 }));
        expect(saved.endOffset).toBe(0);
    });
});

describe("PgMessagePageRepository.findByBotMessageId", () => {
    test("returns null for a non-existent botDiscordMessageId", async () => {
        const result = await pageRepo.findByBotMessageId("no-such-id");
        expect(result).toBeNull();
    });

    test("returns the saved page by its botDiscordMessageId", async () => {
        const parent = await saveParentMessage("bot-find-001");
        await pageRepo.save(pagePayload(parent.discordMessageId, { currentPage: 2, totalPages: 5, endOffset: 500 }));

        const result = await pageRepo.findByBotMessageId("bot-find-001");

        expect(result).not.toBeNull();
        expect(result?.botDiscordMessageId).toBe("bot-find-001");
        expect(result?.currentPage).toBe(2);
        expect(result?.totalPages).toBe(5);
        expect(result?.endOffset).toBe(500);
        expect(result?.createdAt).toBeInstanceOf(Date);
    });

    test("returns the correct page when multiple pages exist for different messages", async () => {
        const p1 = await saveParentMessage("bot-multi-1");
        const p2 = await saveParentMessage("bot-multi-2");

        await pageRepo.save(pagePayload(p1.discordMessageId, { currentPage: 1, totalPages: 2 }));
        await pageRepo.save(pagePayload(p2.discordMessageId, { currentPage: 3, totalPages: 4 }));

        const result = await pageRepo.findByBotMessageId("bot-multi-2");

        expect(result?.botDiscordMessageId).toBe("bot-multi-2");
        expect(result?.currentPage).toBe(3);
        expect(result?.totalPages).toBe(4);
    });
});

describe("PgMessagePageRepository.delete", () => {
    test("deletes an existing page by id — subsequent find returns null", async () => {
        const parent = await saveParentMessage("bot-del-001");
        const saved = await pageRepo.save(pagePayload(parent.discordMessageId));

        await pageRepo.delete(saved.id);

        const result = await pageRepo.findByBotMessageId("bot-del-001");
        expect(result).toBeNull();
    });

    test("deleting a non-existent id does not throw", async () => {
        // Should resolve without error
        await expect(pageRepo.delete("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
    });

    test("deleting parent message cascades and removes the page row", async () => {
        const parent = await saveParentMessage("bot-cascade-001");
        await pageRepo.save(pagePayload(parent.discordMessageId));

        // Delete the parent — CASCADE should remove the page row
        await db.execute(sql`DELETE FROM messages WHERE discord_message_id = ${"bot-cascade-001"}`);

        const result = await pageRepo.findByBotMessageId("bot-cascade-001");
        expect(result).toBeNull();
    });
});
