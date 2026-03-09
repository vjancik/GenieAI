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
import {
    geminiApiKeys,
    geminiFiles,
    geminiFileUploads,
    messages,
} from "../../../src/infrastructure/db/schema.ts";

/**
 * Integration tests for the `gemini_file_uploads_stale_cleanup` trigger.
 *
 * The trigger fires BEFORE INSERT (FOR EACH STATEMENT) on `gemini_file_uploads`
 * and deletes all rows whose `uploaded_at` is older than 48 hours. This keeps
 * the table lean without requiring a separate scheduled job.
 *
 * Test strategy:
 * 1. Insert a stale upload row directly with a 49-hour-old uploaded_at timestamp.
 *    The trigger fires on this INSERT but has nothing to clean yet — the row is inserted.
 * 2. Insert a fresh upload row. The trigger fires again BEFORE the new INSERT,
 *    this time finding and deleting the stale row.
 * 3. Assert only the fresh row remains.
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

beforeAll(async () => {
    db = createDb(TEST_DB_URL);
    testLogger.info("Trigger integration tests: DB connected");
});

afterEach(async () => {
    await db.execute(
        sql`TRUNCATE TABLE gemini_file_uploads, gemini_files, gemini_api_keys, messages RESTART IDENTITY CASCADE`,
    );
});

afterAll(async () => {
    await (
        db as unknown as { $client: { end?: () => Promise<void> } }
    ).$client?.end?.();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Inserts a messages row so gemini_files FK is satisfied. */
async function insertTestMessage(
    discordMessageId = "trigger-test-msg",
): Promise<string> {
    await db.insert(messages).values({
        discordMessageId,
        repliesToDiscordId: null,
        channelId: "ch-trigger",
        guildId: null,
        role: "human",
        // TYPE COERCION: empty array satisfies the column type for test isolation
        langchainMessages: [] as unknown as Record<string, unknown>[],
    });
    return discordMessageId;
}

/** Inserts a gemini_api_keys row and returns its UUID. */
async function insertTestApiKey(apiKey = "trigger-test-key"): Promise<string> {
    const [row] = await db
        .insert(geminiApiKeys)
        .values({ apiKey, isPaid: false })
        .returning();
    if (!row) throw new Error("Failed to insert test API key");
    return row.id;
}

/**
 * Inserts a gemini_files row and returns its UUID.
 * `messageDiscordId` must already exist in the messages table.
 */
async function insertTestFile(
    originalGeminiUrl: string,
    messageDiscordId = "trigger-test-msg",
): Promise<string> {
    const [row] = await db
        .insert(geminiFiles)
        .values({
            originalGeminiUrl,
            discordAttachmentId: `att-${originalGeminiUrl.slice(-4)}`,
            discordFilename: "test.png",
            messageDiscordId,
        })
        .returning();
    if (!row) throw new Error("Failed to insert test gemini file");
    return row.id;
}

// ─── Trigger tests ───────────────────────────────────────────────────────────

describe("gemini_file_uploads_stale_cleanup trigger", () => {
    test("deletes a stale row (>48h) when a fresh row is inserted", async () => {
        const msgId = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();

        // Two separate gemini_files so we can have distinct (file, key) pairs
        const staleFileId = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/stale-file",
            msgId,
        );
        const freshFileId = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/fresh-file",
            msgId,
        );

        // Step 1: Insert stale row (49h ago).
        // Trigger fires — nothing stale exists yet — row is inserted.
        const staleUploadedAt = new Date(Date.now() - 49 * 60 * 60 * 1000);
        await db.insert(geminiFileUploads).values({
            geminiFileId: staleFileId,
            apiKeyId,
            geminiFileName: "files/stale-uuid",
            geminiUrl:
                "https://generativelanguage.googleapis.com/v1beta/files/stale-uuid",
            uploadedAt: staleUploadedAt,
        });

        // Verify the stale row is present before the fresh insert
        const beforeInsert = await db.select().from(geminiFileUploads);
        expect(beforeInsert).toHaveLength(1);
        expect(beforeInsert[0]?.geminiFileName).toBe("files/stale-uuid");

        // Step 2: Insert fresh row.
        // Trigger fires BEFORE this INSERT — deletes the stale row.
        // Then the fresh row is inserted.
        await db.insert(geminiFileUploads).values({
            geminiFileId: freshFileId,
            apiKeyId,
            geminiFileName: "files/fresh-uuid",
            geminiUrl:
                "https://generativelanguage.googleapis.com/v1beta/files/fresh-uuid",
            uploadedAt: new Date(),
        });

        // Step 3: Assert only the fresh row remains
        const afterInsert = await db.select().from(geminiFileUploads);
        expect(afterInsert).toHaveLength(1);
        expect(afterInsert[0]?.geminiFileName).toBe("files/fresh-uuid");
    });

    test("does not delete a row that is exactly 47h old (below the 48h threshold)", async () => {
        const msgId = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();

        const recentFileId = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/recent-file",
            msgId,
        );
        const freshFileId = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/another-fresh-file",
            msgId,
        );

        // Insert a "recent" row uploaded 47h ago — within the 48h window, so NOT stale
        const recentUploadedAt = new Date(Date.now() - 47 * 60 * 60 * 1000);
        await db.insert(geminiFileUploads).values({
            geminiFileId: recentFileId,
            apiKeyId,
            geminiFileName: "files/recent-uuid",
            geminiUrl:
                "https://generativelanguage.googleapis.com/v1beta/files/recent-uuid",
            uploadedAt: recentUploadedAt,
        });

        // Insert another fresh row — trigger fires but should not delete the recent row
        await db.insert(geminiFileUploads).values({
            geminiFileId: freshFileId,
            apiKeyId,
            geminiFileName: "files/another-uuid",
            geminiUrl:
                "https://generativelanguage.googleapis.com/v1beta/files/another-uuid",
            uploadedAt: new Date(),
        });

        // Both rows should remain (neither is older than 48h)
        const rows = await db.select().from(geminiFileUploads);
        expect(rows).toHaveLength(2);
        const fileNames = rows.map((r) => r.geminiFileName);
        expect(fileNames).toContain("files/recent-uuid");
        expect(fileNames).toContain("files/another-uuid");
    });

    test("deletes multiple stale rows in a single trigger invocation", async () => {
        const msgId = await insertTestMessage();
        const apiKeyId1 = await insertTestApiKey("key-stale-1");
        const apiKeyId2 = await insertTestApiKey("key-stale-2");
        const freshApiKeyId = await insertTestApiKey("key-fresh");

        const staleFile1Id = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/stale-multi-1",
            msgId,
        );
        const staleFile2Id = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/stale-multi-2",
            msgId,
        );
        const freshFileId = await insertTestFile(
            "https://generativelanguage.googleapis.com/v1beta/files/fresh-multi",
            msgId,
        );

        const staleTime = new Date(Date.now() - 49 * 60 * 60 * 1000);

        // Insert both stale rows in a single statement so the BEFORE INSERT
        // FOR EACH STATEMENT trigger fires only once (before anything is
        // stale), allowing both rows to land in the table.
        await db.insert(geminiFileUploads).values([
            {
                geminiFileId: staleFile1Id,
                apiKeyId: apiKeyId1,
                geminiFileName: "files/stale-multi-1-uuid",
                geminiUrl:
                    "https://generativelanguage.googleapis.com/v1beta/files/stale-multi-1-uuid",
                uploadedAt: staleTime,
            },
            {
                geminiFileId: staleFile2Id,
                apiKeyId: apiKeyId2,
                geminiFileName: "files/stale-multi-2-uuid",
                geminiUrl:
                    "https://generativelanguage.googleapis.com/v1beta/files/stale-multi-2-uuid",
                uploadedAt: staleTime,
            },
        ]);

        // Verify two rows exist
        const beforeInsert = await db.select().from(geminiFileUploads);
        expect(beforeInsert).toHaveLength(2);

        // Insert a fresh row — trigger deletes BOTH stale rows before inserting this one
        await db.insert(geminiFileUploads).values({
            geminiFileId: freshFileId,
            apiKeyId: freshApiKeyId,
            geminiFileName: "files/fresh-multi-uuid",
            geminiUrl:
                "https://generativelanguage.googleapis.com/v1beta/files/fresh-multi-uuid",
            uploadedAt: new Date(),
        });

        // Only the fresh row remains
        const afterInsert = await db.select().from(geminiFileUploads);
        expect(afterInsert).toHaveLength(1);
        expect(afterInsert[0]?.geminiFileName).toBe("files/fresh-multi-uuid");
    });
});
