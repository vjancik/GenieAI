import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { load } from "@langchain/core/load";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { sleep } from "bun";
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

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgresql://genie_test:genie_test@localhost:5433/genie_test";

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
function messagePayload(
    overrides: Partial<Omit<DiscordMessage, "id" | "createdAt">> = {},
): Omit<DiscordMessage, "id" | "createdAt"> {
    const defaultMsg = new HumanMessage("Hello!");
    return {
        discordMessageId: `discord-${Date.now()}-${Math.random()}`,
        repliesToDiscordId: null,
        channelId: "ch-001",
        guildId: "guild-001",
        role: "human",
        langchainMessages: [defaultMsg.toJSON() as unknown as Record<string, unknown>],
        retriesLeft: null,
        ...overrides,
    };
}

describe("PgMessageRepository.save", () => {
    test("saves a message and returns the DB-assigned id", async () => {
        const humanMsg = new HumanMessage("Hello!");
        const payload = messagePayload({
            langchainMessages: [humanMsg.toJSON() as unknown as Record<string, unknown>],
        });
        const saved = await repo.save(payload);

        expect(saved.id).toBeDefined();
        expect(typeof saved.id).toBe("string");
    });

    test("throws DatabaseError on duplicate discordMessageId", async () => {
        const payload = messagePayload({ discordMessageId: "dup-001" });
        await repo.save(payload);

        expect(repo.save(payload)).rejects.toBeInstanceOf(DatabaseError);
    });

    test("saves message with a repliesToDiscordId reference", async () => {
        await repo.save(messagePayload({ discordMessageId: "root-001" }));
        // child row links to root by discordMessageId — fetchChain verifies the link
        await repo.save(
            messagePayload({
                discordMessageId: "child-001",
                repliesToDiscordId: "root-001",
            }),
        );
        const chain = await repo.fetchChain({
            startDiscordMessageId: "child-001",
            channelId: "ch-001",
            guildId: "guild-001",
        });
        expect(chain).toHaveLength(2);
        expect(chain[1]?.repliesToDiscordId).toBe("root-001");
    });
});

describe("PgMessageRepository.fetchChain", () => {
    test("returns empty array for non-existent discordMessageId", async () => {
        const result = await repo.fetchChain({
            startDiscordMessageId: "nonexistent-id",
            channelId: "ch-001",
            guildId: "guild-001",
        });
        expect(result).toHaveLength(0);
    });

    test("returns single message for chain with no parents", async () => {
        const _saved = await repo.save(messagePayload({ discordMessageId: "single-001" }));

        const chain = await repo.fetchChain({
            startDiscordMessageId: "single-001",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(chain).toHaveLength(1);
        expect(chain[0]?.discordMessageId).toBe("single-001");
    });

    test("returns two messages in correct chronological order for two-message chain", async () => {
        // root (no parent) → child (replies to root)
        const humanMsg = new HumanMessage("User question");
        const aiMsg = new AIMessage("Bot response");

        await repo.save(
            messagePayload({
                discordMessageId: "chain2-root",
                role: "human",
                langchainMessages: [humanMsg.toJSON() as unknown as Record<string, unknown>],
            }),
        );

        // Brief delay to ensure distinct createdAt timestamps
        await sleep(10);

        await repo.save(
            messagePayload({
                discordMessageId: "chain2-child",
                repliesToDiscordId: "chain2-root",
                role: "assistant",
                langchainMessages: [aiMsg.toJSON() as unknown as Record<string, unknown>],
            }),
        );

        const chain = await repo.fetchChain({
            startDiscordMessageId: "chain2-child",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(chain).toHaveLength(2);
        // Chronological: root first, then child
        expect(chain[0]?.discordMessageId).toBe("chain2-root");
        expect(chain[1]?.discordMessageId).toBe("chain2-child");
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
        const [id1, id2, id3, id4] = ["chain4-1", "chain4-2", "chain4-3", "chain4-4"] as [
            string,
            string,
            string,
            string,
        ];
        const ids = [id1, id2, id3, id4];

        await repo.save(
            messagePayload({
                discordMessageId: id1,
                repliesToDiscordId: null,
                role: "human",
            }),
        );
        await sleep(5);
        await repo.save(
            messagePayload({
                discordMessageId: id2,
                repliesToDiscordId: id1,
                role: "assistant",
            }),
        );
        await sleep(5);
        await repo.save(
            messagePayload({
                discordMessageId: id3,
                repliesToDiscordId: id2,
                role: "human",
            }),
        );
        await sleep(5);
        await repo.save(
            messagePayload({
                discordMessageId: id4,
                repliesToDiscordId: id3,
                role: "assistant",
            }),
        );

        // Fetch starting from the leaf — the new user message would reference the last bot reply
        const chain = await repo.fetchChain({ startDiscordMessageId: id4, channelId: "ch-001", guildId: "guild-001" });

        expect(chain).toHaveLength(4);
        expect(chain.map((m) => m.discordMessageId)).toEqual(ids);
    });

    test("fetching from an intermediate node only returns that sub-chain", async () => {
        // A 3-message chain: A → B → C
        // fetchChain(B) should return [A, B] not [A, B, C]
        await repo.save(
            messagePayload({
                discordMessageId: "sub-A",
                repliesToDiscordId: null,
            }),
        );
        await sleep(5);
        await repo.save(
            messagePayload({
                discordMessageId: "sub-B",
                repliesToDiscordId: "sub-A",
            }),
        );
        await sleep(5);
        await repo.save(
            messagePayload({
                discordMessageId: "sub-C",
                repliesToDiscordId: "sub-B",
            }),
        );

        const chain = await repo.fetchChain({
            startDiscordMessageId: "sub-B",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(chain).toHaveLength(2);
        expect(chain.map((m) => m.discordMessageId)).toEqual(["sub-A", "sub-B"]);
    });

    test("preserves langchainMessages JSON round-trip correctly for a single message", async () => {
        const originalMsg = new HumanMessage("Hello, round-trip!");
        await repo.save(
            messagePayload({
                discordMessageId: "json-001",
                langchainMessages: [originalMsg.toJSON() as unknown as Record<string, unknown>],
            }),
        );

        const chain = await repo.fetchChain({
            startDiscordMessageId: "json-001",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(chain).toHaveLength(1);
        expect(chain[0]?.langchainMessages).toHaveLength(1);

        // Verify the stored JSON reconstructs to the correct LangChain class
        const reconstructed = await load(JSON.stringify(chain[0]?.langchainMessages[0]));
        expect(reconstructed).toBeInstanceOf(HumanMessage);
        expect((reconstructed as HumanMessage).content).toBe("Hello, round-trip!");
    });

    test("preserves multiple langchainMessages per record (e.g. triage + tool + final)", async () => {
        const triageMsg = new AIMessage("triage response");
        const finalMsg = new AIMessage("final answer");

        await repo.save(
            messagePayload({
                discordMessageId: "multi-001",
                role: "assistant",
                langchainMessages: [
                    triageMsg.toJSON() as unknown as Record<string, unknown>,
                    finalMsg.toJSON() as unknown as Record<string, unknown>,
                ],
            }),
        );

        const chain = await repo.fetchChain({
            startDiscordMessageId: "multi-001",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(chain[0]?.langchainMessages).toHaveLength(2);

        const first = await load(JSON.stringify(chain[0]?.langchainMessages[0]));
        const second = await load(JSON.stringify(chain[0]?.langchainMessages[1]));
        expect(first).toBeInstanceOf(AIMessage);
        expect((first as AIMessage).content).toBe("triage response");
        expect(second).toBeInstanceOf(AIMessage);
        expect((second as AIMessage).content).toBe("final answer");
    });
});

describe("PgMessageRepository.findExistingDiscordIds", () => {
    test("returns empty array for empty input", async () => {
        const result = await repo.findExistingDiscordIds({
            guildId: "guild-001",
            channelId: "ch-001",
            discordMessageIds: [],
        });
        expect(result).toEqual([]);
    });

    test("returns all IDs that exist in DB", async () => {
        await repo.save(messagePayload({ discordMessageId: "exist-001" }));
        await repo.save(messagePayload({ discordMessageId: "exist-002" }));

        const result = await repo.findExistingDiscordIds({
            guildId: "guild-001",
            channelId: "ch-001",
            discordMessageIds: ["exist-001", "exist-002", "missing-001"],
        });

        expect(result).toHaveLength(2);
        expect(result).toContain("exist-001");
        expect(result).toContain("exist-002");
    });

    test("returns empty array when none of the IDs exist", async () => {
        const result = await repo.findExistingDiscordIds({
            guildId: "guild-001",
            channelId: "ch-001",
            discordMessageIds: ["ghost-001", "ghost-002"],
        });
        expect(result).toEqual([]);
    });

    test("does not return IDs from a different channel", async () => {
        await repo.save(messagePayload({ discordMessageId: "cross-001", channelId: "ch-other" }));

        const result = await repo.findExistingDiscordIds({
            guildId: "guild-001",
            channelId: "ch-001",
            discordMessageIds: ["cross-001"],
        });
        expect(result).toEqual([]);
    });

    test("does not return IDs from a different guild", async () => {
        await repo.save(messagePayload({ discordMessageId: "guild-cross-001", guildId: "guild-other" }));

        const result = await repo.findExistingDiscordIds({
            guildId: "guild-001",
            channelId: "ch-001",
            discordMessageIds: ["guild-cross-001"],
        });
        expect(result).toEqual([]);
    });
});

describe("PgMessageRepository.saveBatch", () => {
    test("returns empty array for empty input", async () => {
        const result = await repo.saveBatch([]);
        expect(result).toEqual([]);
    });

    test("saves a single row and returns its id", async () => {
        const payload = messagePayload({ discordMessageId: "batch-001" });
        const result = await repo.saveBatch([payload]);

        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBeDefined();
        expect(typeof result[0]?.id).toBe("string");
    });

    test("saves a batch of multiple rows and returns N ids", async () => {
        const payloads = [
            messagePayload({ discordMessageId: "batch-multi-1" }),
            messagePayload({ discordMessageId: "batch-multi-2" }),
            messagePayload({ discordMessageId: "batch-multi-3" }),
        ];
        const result = await repo.saveBatch(payloads);

        expect(result).toHaveLength(3);
        // All ids should be distinct strings
        const ids = result.map((r) => r.id);
        expect(new Set(ids).size).toBe(3);
    });

    test("returns existing id on duplicate (no-op conflict update, always N rows)", async () => {
        const payload = messagePayload({ discordMessageId: "batch-dup-001" });
        const first = await repo.saveBatch([payload]);
        expect(first).toHaveLength(1);

        // Second call returns the existing row's id
        const second = await repo.saveBatch([payload]);
        expect(second).toHaveLength(1);
        expect(second[0]?.id).toBe(first[0]?.id);
    });

    test("partial batch: returns N ids index-aligned with input (existing + new)", async () => {
        const existing = messagePayload({ discordMessageId: "batch-partial-existing" });
        const { id: existingId } = await repo.save(existing);

        const result = await repo.saveBatch([existing, messagePayload({ discordMessageId: "batch-partial-new" })]);

        // Always 2 rows — index 0 is the pre-existing row, index 1 is the new row
        expect(result).toHaveLength(2);
        expect(result[0]?.id).toBe(existingId);
        expect(result[1]?.id).toBeDefined();
    });
});
