import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { messages } from "../../../src/infrastructure/db/schema.ts";

/**
 * Integration tests verifying that Bun's SQL driver returns JSON columns as parsed
 * objects (not strings) when selected via Drizzle ORM queries (prepared statements,
 * `.select()`, etc.).
 *
 * NOTE: this does NOT apply to raw `db.execute(sql`...`)` calls, which return JSON
 * columns as raw strings. See `PgMessageRepository.fetchChain` for that case.
 *
 * These tests document and pin the actual runtime behavior so we know if it ever changes.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_TEST_URL env var set to the test DB connection string
 */

const TEST_DB_URL = process.env.DATABASE_TEST_URL ?? "postgresql://genie_test:genie_test@localhost:5433/genie_test";

let db: ReturnType<typeof createDb>;

beforeAll(() => {
    db = createDb(TEST_DB_URL);
});

afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE messages RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
});

describe("Bun SQL JSON column deserialization behavior", () => {
    test("langchain_messages is returned as a parsed object array, not a string", async () => {
        const payload = [
            { type: "constructor", id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "hello" } },
        ];

        await db.insert(messages).values({
            discordMessageId: "test-snowflake-1",
            repliesToDiscordId: null,
            channelId: "ch-test",
            guildId: "guild-test",
            role: "human",
            discordAuthorId: "user-test",
            langchainMessages: payload,
            retriesLeft: null,
            usedFallback: null,
            interactionType: null,
            interactionAuthorDiscordId: null,
        });

        const [row] = await db.select({ langchainMessages: messages.langchainMessages }).from(messages).limit(1);

        if (!row) throw new Error("Expected a row to be returned");
        expect(typeof row.langchainMessages).not.toBe("string");
        expect(Array.isArray(row.langchainMessages)).toBe(true);
        expect(row.langchainMessages).toEqual(payload);
    });

    test("nested object structure is preserved round-trip", async () => {
        const payload = [
            {
                type: "constructor",
                id: ["langchain_core", "messages", "AIMessage"],
                kwargs: {
                    content: "response",
                    additional_kwargs: {
                        groundingMetadata: {
                            groundingChunks: [{ web: { uri: "https://example.com", title: "example" } }],
                        },
                    },
                    response_metadata: { tokenCount: { totalTokenCount: 42 } },
                },
            },
        ];

        await db.insert(messages).values({
            discordMessageId: "test-snowflake-2",
            repliesToDiscordId: null,
            channelId: "ch-test",
            guildId: "guild-test",
            role: "assistant",
            discordAuthorId: "bot-test",
            langchainMessages: payload,
            retriesLeft: null,
            usedFallback: null,
            interactionType: null,
            interactionAuthorDiscordId: null,
        });

        const [row] = await db.select({ langchainMessages: messages.langchainMessages }).from(messages).limit(1);

        if (!row) throw new Error("Expected a row to be returned");
        expect(row.langchainMessages).toEqual(payload);
    });
});
