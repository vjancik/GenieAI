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
 * Each test inserts a parent messages row first (required by the FK on
 * message_pages.message_id and message_pages.first_page_message_id), then exercises
 * the page repository.
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

/** Insert a messages row so the FK constraints on message_pages are satisfied. */
async function saveParentMessage(discordMessageId: string): Promise<DiscordMessage> {
    return messageRepo.save({
        discordMessageId,
        repliesToDiscordId: null,
        channelId: "ch-001",
        guildId: "guild-001",
        role: "assistant",
        langchainMessages: [new HumanMessage("stub").toJSON() as unknown as Record<string, unknown>],
        retriesLeft: null,
    });
}

function pagePayload(
    messageId: string,
    firstPageMessageId: string,
    overrides: Partial<Omit<MessagePage, "id" | "createdAt" | "messageId" | "firstPageMessageId">> = {},
): Omit<MessagePage, "id" | "createdAt"> {
    return {
        messageId,
        firstPageMessageId,
        endOffset: 1800,
        currentPage: 1,
        totalPages: 3,
        endedInCodeBlock: false,
        codeBlockType: null,
        ...overrides,
    };
}

describe("PgMessagePageRepository.save", () => {
    test("saves a page and returns it with generated id and createdAt", async () => {
        const parent = await saveParentMessage("bot-save-001");
        const payload = pagePayload(parent.id, parent.id);

        const saved = await pageRepo.save(payload);

        expect(saved.id).toBeDefined();
        expect(typeof saved.id).toBe("string");
        expect(saved.messageId).toBe(parent.id);
        expect(saved.firstPageMessageId).toBe(parent.id);
        expect(saved.endOffset).toBe(1800);
        expect(saved.currentPage).toBe(1);
        expect(saved.totalPages).toBe(3);
        expect(saved.createdAt).toBeInstanceOf(Date);
    });

    test("throws DatabaseError on duplicate messageId", async () => {
        const parent = await saveParentMessage("bot-dup-001");
        const payload = pagePayload(parent.id, parent.id);

        await pageRepo.save(payload);

        expect(pageRepo.save(payload)).rejects.toBeInstanceOf(DatabaseError);
    });

    test("saves page with endOffset=0 (start of page 2 is beginning of text)", async () => {
        const parent = await saveParentMessage("bot-offset-zero");
        const saved = await pageRepo.save(pagePayload(parent.id, parent.id, { endOffset: 0 }));
        expect(saved.endOffset).toBe(0);
    });

    test("multiple page rows can share the same firstPageMessageId", async () => {
        // Simulate pages 2 and 3 of the same response all pointing to the first page message.
        // Each page needs its own messages row (FK on message_id).
        const firstPage = await saveParentMessage("first-page-001");
        const page2Msg = await saveParentMessage("page-2-msg-001");
        const page3Msg = await saveParentMessage("page-3-msg-001");

        const page2 = await pageRepo.save(pagePayload(page2Msg.id, firstPage.id, { currentPage: 2 }));
        const page3 = await pageRepo.save(pagePayload(page3Msg.id, firstPage.id, { currentPage: 3 }));

        expect(page2.firstPageMessageId).toBe(firstPage.id);
        expect(page3.firstPageMessageId).toBe(firstPage.id);
        expect(page2.messageId).toBe(page2Msg.id);
        expect(page3.messageId).toBe(page3Msg.id);
    });
});

describe("PgMessagePageRepository.findByMessageId", () => {
    test("returns null for a non-existent messageId", async () => {
        const result = await pageRepo.findByMessageId("00000000-0000-0000-0000-000000000000");
        expect(result).toBeNull();
    });

    test("returns the saved page by its messageId", async () => {
        const parent = await saveParentMessage("bot-find-001");
        await pageRepo.save(
            pagePayload(parent.id, parent.id, {
                currentPage: 2,
                totalPages: 5,
                endOffset: 500,
            }),
        );

        const result = await pageRepo.findByMessageId(parent.id);

        expect(result).not.toBeNull();
        expect(result?.messageId).toBe(parent.id);
        expect(result?.firstPageMessageId).toBe(parent.id);
        expect(result?.currentPage).toBe(2);
        expect(result?.totalPages).toBe(5);
        expect(result?.endOffset).toBe(500);
        expect(result?.createdAt).toBeInstanceOf(Date);
    });

    test("returns the correct page when multiple pages exist for different messages", async () => {
        const p1 = await saveParentMessage("bot-multi-1");
        const p2 = await saveParentMessage("bot-multi-2");

        await pageRepo.save(pagePayload(p1.id, p1.id, { currentPage: 1, totalPages: 2 }));
        await pageRepo.save(pagePayload(p2.id, p2.id, { currentPage: 3, totalPages: 4 }));

        const result = await pageRepo.findByMessageId(p2.id);

        expect(result?.messageId).toBe(p2.id);
        expect(result?.currentPage).toBe(3);
        expect(result?.totalPages).toBe(4);
    });

    test("finds a subsequent-page row by its messageId", async () => {
        const firstPage = await saveParentMessage("first-page-lookup");
        const page2Msg = await saveParentMessage("page-2-lookup");
        await pageRepo.save(pagePayload(page2Msg.id, firstPage.id, { currentPage: 2 }));

        const result = await pageRepo.findByMessageId(page2Msg.id);

        expect(result?.messageId).toBe(page2Msg.id);
        expect(result?.firstPageMessageId).toBe(firstPage.id);
        expect(result?.currentPage).toBe(2);
    });
});

describe("PgMessagePageRepository — cascade behaviour", () => {
    test("deleting the bot message row cascades and removes its page row", async () => {
        const firstPage = await saveParentMessage("first-page-cascade");
        const page2Msg = await saveParentMessage("page-2-cascade");
        const page3Msg = await saveParentMessage("page-3-cascade");
        await pageRepo.save(pagePayload(page2Msg.id, firstPage.id, { currentPage: 2 }));
        await pageRepo.save(pagePayload(page3Msg.id, firstPage.id, { currentPage: 3 }));

        // Delete page 2's messages row — its page row should cascade
        await db.execute(sql`DELETE FROM messages WHERE id = ${page2Msg.id}`);

        expect(await pageRepo.findByMessageId(page2Msg.id)).toBeNull();
        // page 3 is unaffected
        expect(await pageRepo.findByMessageId(page3Msg.id)).not.toBeNull();
    });

    test("deleting the first-page parent message cascades and removes all page rows", async () => {
        const firstPage = await saveParentMessage("first-page-cascade-all");
        const page2Msg = await saveParentMessage("page-2-cascade-all");
        const page3Msg = await saveParentMessage("page-3-cascade-all");
        await pageRepo.save(pagePayload(page2Msg.id, firstPage.id, { currentPage: 2 }));
        await pageRepo.save(pagePayload(page3Msg.id, firstPage.id, { currentPage: 3 }));

        // Delete the first page's messages row — all page rows should cascade via firstPageMessageId FK
        await db.execute(sql`DELETE FROM messages WHERE id = ${firstPage.id}`);

        expect(await pageRepo.findByMessageId(page2Msg.id)).toBeNull();
        expect(await pageRepo.findByMessageId(page3Msg.id)).toBeNull();
    });
});
