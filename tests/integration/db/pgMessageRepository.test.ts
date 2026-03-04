import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import pino from "pino";
import { DatabaseError } from "../../../src/domain/errors/AppError.ts";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { PgMessageRepository } from "../../../src/infrastructure/db/repositories/PgMessageRepository.ts";

/**
 * Integration tests for PgMessageRepository.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_URL env var set to the test DB connection string
 *
 * The test DATABASE_URL defaults to the test DB if not set externally.
 */

const TEST_DB_URL =
    process.env["DATABASE_URL"] ??
    "postgresql://genie_test:genie_test@localhost:5433/genie_test";

const testLogger = pino({ level: "silent" });

let db: ReturnType<typeof createDb>;
let repo: PgMessageRepository;

beforeAll(async () => {
    db = createDb(TEST_DB_URL);
    repo = new PgMessageRepository(db, testLogger);
});

afterEach(async () => {
    // Truncate messages table between tests for isolation
    await db.execute(sql`TRUNCATE TABLE messages RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
    // Close the Bun SQL connection
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
});

/** Helper: build a minimal save payload */
function messagePayload(overrides: Partial<Omit<DiscordMessage, "id" | "createdAt">> = {}): Omit<DiscordMessage, "id" | "createdAt"> {
    return {
        discordMessageId: `discord-${Date.now()}-${Math.random()}`,
        repliesToDiscordId: null,
        channelId: "ch-001",
        guildId: "guild-001",
        role: "human",
        contentChunks: [{ type: "text", text: "Hello!" }],
        ...overrides,
    };
}

describe("PgMessageRepository.save", () => {
    test("saves a message and returns it with id and createdAt", async () => {
        const payload = messagePayload();
        const saved = await repo.save(payload);

        expect(saved.id).toBeDefined();
        expect(typeof saved.id).toBe("string");
        expect(saved.discordMessageId).toBe(payload.discordMessageId);
        expect(saved.role).toBe("human");
        expect(saved.contentChunks).toEqual([{ type: "text", text: "Hello!" }]);
        expect(saved.createdAt).toBeInstanceOf(Date);
    });

    test("throws DatabaseError on duplicate discordMessageId", async () => {
        const payload = messagePayload({ discordMessageId: "dup-001" });
        await repo.save(payload);

        await expect(repo.save(payload)).rejects.toBeInstanceOf(DatabaseError);
    });

    test("saves message with null repliesToDiscordId (chain root)", async () => {
        const payload = messagePayload({ repliesToDiscordId: null });
        const saved = await repo.save(payload);
        expect(saved.repliesToDiscordId).toBeNull();
    });

    test("saves message with a repliesToDiscordId reference", async () => {
        const root = await repo.save(messagePayload({ discordMessageId: "root-001" }));
        const child = await repo.save(
            messagePayload({
                discordMessageId: "child-001",
                repliesToDiscordId: root.discordMessageId,
            })
        );
        expect(child.repliesToDiscordId).toBe("root-001");
    });
});

describe("PgMessageRepository.fetchChain", () => {
    test("returns empty array for non-existent discordMessageId", async () => {
        const result = await repo.fetchChain("nonexistent-id");
        expect(result).toHaveLength(0);
    });

    test("returns single message for chain with no parents", async () => {
        const saved = await repo.save(
            messagePayload({ discordMessageId: "single-001" })
        );

        const chain = await repo.fetchChain("single-001");

        expect(chain).toHaveLength(1);
        expect(chain[0]!.discordMessageId).toBe("single-001");
    });

    test("returns two messages in correct chronological order for two-message chain", async () => {
        // root (no parent) → child (replies to root)
        const root = await repo.save(
            messagePayload({
                discordMessageId: "chain2-root",
                role: "human",
                contentChunks: [{ type: "text", text: "User question" }],
            })
        );

        // Brief delay to ensure distinct createdAt timestamps
        await Bun.sleep(10);

        const child = await repo.save(
            messagePayload({
                discordMessageId: "chain2-child",
                repliesToDiscordId: root.discordMessageId,
                role: "assistant",
                contentChunks: [{ type: "text", text: "Bot response" }],
            })
        );

        const chain = await repo.fetchChain(child.discordMessageId);

        expect(chain).toHaveLength(2);
        // Chronological: root first, then child
        expect(chain[0]!.discordMessageId).toBe("chain2-root");
        expect(chain[1]!.discordMessageId).toBe("chain2-child");
    });

    test("returns all four messages in a full user→bot→user→bot chain", async () => {
        /**
         * Chain structure:
         *   msg1 (human) ← root
         *   msg2 (assistant, replies to msg1)
         *   msg3 (human, replies to msg2)
         *   msg4 (assistant, replies to msg3)
         *
         * fetchChain(msg4) should walk: msg4 → msg3 → msg2 → msg1
         * and return them chronologically: msg1, msg2, msg3, msg4
         */
        const ids = ["chain4-1", "chain4-2", "chain4-3", "chain4-4"];

        await repo.save(messagePayload({ discordMessageId: ids[0]!, repliesToDiscordId: null, role: "human" }));
        await Bun.sleep(5);
        await repo.save(messagePayload({ discordMessageId: ids[1]!, repliesToDiscordId: ids[0]!, role: "assistant" }));
        await Bun.sleep(5);
        await repo.save(messagePayload({ discordMessageId: ids[2]!, repliesToDiscordId: ids[1]!, role: "human" }));
        await Bun.sleep(5);
        await repo.save(messagePayload({ discordMessageId: ids[3]!, repliesToDiscordId: ids[2]!, role: "assistant" }));

        // Fetch starting from the leaf — the new user message would reference the last bot reply
        const chain = await repo.fetchChain(ids[3]!);

        expect(chain).toHaveLength(4);
        expect(chain.map((m) => m.discordMessageId)).toEqual(ids);
    });

    test("fetching from an intermediate node only returns that sub-chain", async () => {
        // A 3-message chain: A → B → C
        // fetchChain(B) should return [A, B] not [A, B, C]
        await repo.save(messagePayload({ discordMessageId: "sub-A", repliesToDiscordId: null }));
        await Bun.sleep(5);
        await repo.save(messagePayload({ discordMessageId: "sub-B", repliesToDiscordId: "sub-A" }));
        await Bun.sleep(5);
        await repo.save(messagePayload({ discordMessageId: "sub-C", repliesToDiscordId: "sub-B" }));

        const chain = await repo.fetchChain("sub-B");

        expect(chain).toHaveLength(2);
        expect(chain.map((m) => m.discordMessageId)).toEqual(["sub-A", "sub-B"]);
    });

    test("preserves contentChunks JSONB round-trip correctly", async () => {
        const chunks = [
            { type: "text" as const, text: "Here is an image:" },
            { type: "image_url" as const, image_url: "https://example.com/img.png" },
        ];

        const saved = await repo.save(
            messagePayload({
                discordMessageId: "json-001",
                contentChunks: chunks,
            })
        );

        const chain = await repo.fetchChain(saved.discordMessageId);

        expect(chain).toHaveLength(1);
        expect(chain[0]!.contentChunks).toEqual(chunks);
    });
});
