import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { PgGeminiApiKeyRepository } from "../../../src/infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { geminiApiKeys, geminiFiles, geminiFileUploads, messages } from "../../../src/infrastructure/db/schema.ts";

/**
 * Integration tests for PgGeminiApiKeyRepository.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_URL env var set to the test DB connection string
 */

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgresql://genie_test:genie_test@localhost:5433/genie_test";

const testLogger = pino({ level: "silent" });

let db: ReturnType<typeof createDb>;
let repo: PgGeminiApiKeyRepository;

beforeAll(async () => {
    db = createDb(TEST_DB_URL);
    repo = new PgGeminiApiKeyRepository(db, testLogger);
});

afterEach(async () => {
    await db.execute(
        sql`TRUNCATE TABLE gemini_api_keys, gemini_files, gemini_file_uploads, messages RESTART IDENTITY CASCADE`,
    );
});

afterAll(async () => {
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
});

describe("PgGeminiApiKeyRepository.upsert", () => {
    test("inserts a new key and returns it with a generated UUID", async () => {
        const result = await repo.upsert({
            apiKey: "test-free-key",
            isPaid: false,
        });

        expect(result.id).toBeDefined();
        expect(typeof result.id).toBe("string");
        expect(result.apiKey).toBe("test-free-key");
        expect(result.isPaid).toBe(false);
    });

    test("is idempotent: second call returns the same UUID", async () => {
        const first = await repo.upsert({
            apiKey: "test-key",
            isPaid: false,
        });
        const second = await repo.upsert({
            apiKey: "test-key",
            isPaid: false,
        });

        expect(second.id).toBe(first.id);
        expect(second.apiKey).toBe("test-key");
    });

    test("updates isPaid on conflict so a key type can be corrected", async () => {
        const first = await repo.upsert({ apiKey: "flip-key", isPaid: false });
        const updated = await repo.upsert({ apiKey: "flip-key", isPaid: true });

        // Same row — same UUID
        expect(updated.id).toBe(first.id);
        // isPaid updated
        expect(updated.isPaid).toBe(true);
    });

    test("inserts multiple keys as distinct rows with distinct UUIDs", async () => {
        const key1 = await repo.upsert({ apiKey: "key-a", isPaid: false });
        const key2 = await repo.upsert({ apiKey: "key-b", isPaid: false });
        const key3 = await repo.upsert({ apiKey: "key-c", isPaid: true });

        expect(key1.id).not.toBe(key2.id);
        expect(key2.id).not.toBe(key3.id);

        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(3);
    });

    test("reactivates a previously deactivated key on upsert", async () => {
        // Insert then deactivate
        const original = await repo.upsert({
            apiKey: "comeback-key",
            isPaid: false,
        });
        await repo.deactivateNotIn(["some-other-key"]);

        const [deactivated] = await db.select().from(geminiApiKeys);
        expect(deactivated?.isActive).toBe(false);

        // Upsert again — should reactivate
        const reactivated = await repo.upsert({
            apiKey: "comeback-key",
            isPaid: false,
        });
        const [row] = await db.select().from(geminiApiKeys);

        expect(reactivated.id).toBe(original.id); // same stable UUID
        expect(row?.isActive).toBe(true);
    });
});

describe("PgGeminiApiKeyRepository.deactivateNotIn", () => {
    test("sets isActive=false for rows whose apiKey is not in the provided list", async () => {
        const keep = await repo.upsert({ apiKey: "keep-this", isPaid: false });
        await repo.upsert({ apiKey: "deactivate-this", isPaid: false });

        await repo.deactivateNotIn(["keep-this"]);

        const rows = await db.select().from(geminiApiKeys);
        // Both rows still exist — no hard-delete
        expect(rows).toHaveLength(2);

        const keepRow = rows.find((r) => r.apiKey === "keep-this");
        const deactivatedRow = rows.find((r) => r.apiKey === "deactivate-this");

        expect(keepRow?.isActive).toBe(true);
        expect(keepRow?.id).toBe(keep.id);
        expect(deactivatedRow?.isActive).toBe(false);
    });

    test("does not change any rows when called with an empty list", async () => {
        await repo.upsert({ apiKey: "alpha", isPaid: false });
        await repo.upsert({ apiKey: "beta", isPaid: true });

        // Guard: empty list should be a no-op to prevent full-table deactivation
        await repo.deactivateNotIn([]);

        // Both rows must still exist and remain active
        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.isActive)).toBe(true);
    });

    test("leaves all rows active when every key is listed in the keep-list", async () => {
        await repo.upsert({ apiKey: "k1", isPaid: false });
        await repo.upsert({ apiKey: "k2", isPaid: false });

        await repo.deactivateNotIn(["k1", "k2"]);

        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.isActive)).toBe(true);
    });

    test("deactivates all rows when none of their keys appear in the keep-list", async () => {
        await repo.upsert({ apiKey: "gone-1", isPaid: false });
        await repo.upsert({ apiKey: "gone-2", isPaid: false });

        await repo.deactivateNotIn(["some-other-key"]);

        // Rows are preserved — only isActive toggled
        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => !r.isActive)).toBe(true);
    });

    test("preserves associated gemini_file_uploads rows when a key is deactivated", async () => {
        // Minimal message → file anchor → upload chain
        const [msgRow] = await db
            .insert(messages)
            .values({
                discordMessageId: "msg-deactivate-test",
                repliesToDiscordId: null,
                channelId: "ch-test",
                guildId: "@me",
                role: "human",
                // TYPE COERCION: empty array satisfies the column type for test isolation
                langchainMessages: [] as unknown as Record<string, unknown>[],
            })
            .returning();
        if (!msgRow) throw new Error("Failed to insert test message");
        const [fileRow] = await db
            .insert(geminiFiles)
            .values({
                originalGeminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/deactivate-test",
                discordAttachmentId: "att-deactivate",
                discordFilename: "test.png",
                messageId: msgRow.id,
                discordMessageId: "msg-deactivate-test",
            })
            .returning();
        if (!fileRow) throw new Error("Failed to insert test gemini file");

        const key = await repo.upsert({
            apiKey: "key-to-deactivate",
            isPaid: false,
        });
        await db.insert(geminiFileUploads).values({
            geminiFileId: fileRow.id,
            apiKeyId: key.id,
            geminiFileName: "files/deactivate-test-uuid",
            geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/deactivate-test-uuid",
            uploadedAt: new Date(),
        });

        // Deactivate the key
        await repo.deactivateNotIn(["some-other-key"]);

        // Key row preserved (not deleted)
        const keyRows = await db.select().from(geminiApiKeys);
        expect(keyRows).toHaveLength(1);
        expect(keyRows[0]?.isActive).toBe(false);

        // Upload record preserved — the whole point of this feature
        const uploads = await db.select().from(geminiFileUploads);
        expect(uploads).toHaveLength(1);
        expect(uploads[0]?.geminiFileName).toBe("files/deactivate-test-uuid");
    });
});
