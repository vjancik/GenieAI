import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { sql } from "drizzle-orm";
import pino from "pino";
import type { DiscordMessage } from "../../../src/domain/message/Message.ts";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { PgMessageRepository } from "../../../src/infrastructure/db/repositories/PgMessageRepository.ts";

/**
 * Integration tests for PgMessageRepository.findByDiscordMessageId.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_URL env var set to the test DB connection string
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
    await db.execute(sql`TRUNCATE TABLE messages RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
});

function messagePayload(
    overrides: Partial<Omit<DiscordMessage, "id" | "createdAt">> = {},
): Omit<DiscordMessage, "id" | "createdAt"> {
    return {
        discordMessageId: `discord-${Date.now()}-${Math.random()}`,
        repliesToDiscordId: null,
        channelId: "ch-001",
        guildId: "guild-001",
        role: "human",
        langchainMessages: [new HumanMessage("Hello!").toJSON() as unknown as Record<string, unknown>],
        retriesLeft: null,
        ...overrides,
    };
}

describe("PgMessageRepository.findByDiscordMessageId", () => {
    test("returns null for a non-existent discordMessageId", async () => {
        const result = await repo.findByDiscordMessageId({
            discordMessageId: "does-not-exist",
            channelId: "ch-001",
            guildId: "guild-001",
        });
        expect(result).toBeNull();
    });

    test("returns the saved message by its Discord message ID", async () => {
        const payload = messagePayload({ discordMessageId: "find-001" });
        await repo.save(payload);

        const result = await repo.findByDiscordMessageId({
            discordMessageId: "find-001",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(result).not.toBeNull();
        expect(result?.discordMessageId).toBe("find-001");
        expect(result?.channelId).toBe("ch-001");
        expect(result?.guildId).toBe("guild-001");
        expect(result?.role).toBe("human");
        expect(result?.createdAt).toBeInstanceOf(Date);
    });

    test("returns the correct message when multiple messages exist", async () => {
        await repo.save(messagePayload({ discordMessageId: "multi-A" }));
        await repo.save(messagePayload({ discordMessageId: "multi-B" }));
        await repo.save(messagePayload({ discordMessageId: "multi-C" }));

        const result = await repo.findByDiscordMessageId({
            discordMessageId: "multi-B",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(result?.discordMessageId).toBe("multi-B");
    });

    test("preserves langchainMessages JSON round-trip", async () => {
        const msg = new HumanMessage("round-trip text");
        await repo.save(
            messagePayload({
                discordMessageId: "rt-001",
                langchainMessages: [msg.toJSON() as unknown as Record<string, unknown>],
            }),
        );

        const result = await repo.findByDiscordMessageId({
            discordMessageId: "rt-001",
            channelId: "ch-001",
            guildId: "guild-001",
        });

        expect(result?.langchainMessages).toHaveLength(1);
        // Verify structure matches what was stored (kwargs.content holds the text)
        const stored = result?.langchainMessages[0] as Record<string, unknown>;
        const kwargs = stored?.kwargs as Record<string, unknown> | undefined;
        expect(kwargs?.content).toBe("round-trip text");
    });
});
