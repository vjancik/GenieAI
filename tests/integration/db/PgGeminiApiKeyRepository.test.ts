import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from "bun:test";
import { sql } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { PgGeminiApiKeyRepository } from "../../../src/infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { geminiApiKeys } from "../../../src/infrastructure/db/schema.ts";

/**
 * Integration tests for PgGeminiApiKeyRepository.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_URL env var set to the test DB connection string
 */

const TEST_DB_URL =
    process.env.DATABASE_URL ??
    "postgresql://genie_test:genie_test@localhost:5433/genie_test";

const testLogger = pino({ level: "silent" });

let db: ReturnType<typeof createDb>;
let repo: PgGeminiApiKeyRepository;

beforeAll(async () => {
    db = createDb(TEST_DB_URL);
    repo = new PgGeminiApiKeyRepository(db, testLogger);
});

afterEach(async () => {
    // CASCADE also cleans gemini_file_uploads rows referencing these keys
    await db.execute(
        sql`TRUNCATE TABLE gemini_api_keys RESTART IDENTITY CASCADE`,
    );
});

afterAll(async () => {
    await (
        db as unknown as { $client: { end?: () => Promise<void> } }
    ).$client?.end?.();
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
});

describe("PgGeminiApiKeyRepository.deleteNotIn", () => {
    test("deletes rows whose apiKey is not in the provided list", async () => {
        const keep = await repo.upsert({ apiKey: "keep-this", isPaid: false });
        await repo.upsert({ apiKey: "delete-this", isPaid: false });

        await repo.deleteNotIn(["keep-this"]);

        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.apiKey).toBe("keep-this");
        // UUID of retained row is unchanged
        expect(rows[0]?.id).toBe(keep.id);
    });

    test("does not delete any rows when called with an empty list", async () => {
        const k1 = await repo.upsert({ apiKey: "alpha", isPaid: false });
        const k2 = await repo.upsert({ apiKey: "beta", isPaid: true });

        // Guard: empty list should be a no-op to prevent full-table deletion
        await repo.deleteNotIn([]);

        // Both rows must still exist with unchanged UUIDs
        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(2);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(k1.id);
        expect(ids).toContain(k2.id);
    });

    test("retains all rows when every key is listed in the keep-list", async () => {
        await repo.upsert({ apiKey: "k1", isPaid: false });
        await repo.upsert({ apiKey: "k2", isPaid: false });

        await repo.deleteNotIn(["k1", "k2"]);

        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(2);
    });

    test("deletes all rows when none of their keys appear in the keep-list", async () => {
        await repo.upsert({ apiKey: "gone-1", isPaid: false });
        await repo.upsert({ apiKey: "gone-2", isPaid: false });

        await repo.deleteNotIn(["some-other-key"]);

        const rows = await db.select().from(geminiApiKeys);
        expect(rows).toHaveLength(0);
    });
});
