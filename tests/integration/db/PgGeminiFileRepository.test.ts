import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import type { GeminiFile } from "../../../src/domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../../src/domain/message/GeminiFileUpload.ts";
import { createDb } from "../../../src/infrastructure/db/connection.ts";
import { PgGeminiApiKeyRepository } from "../../../src/infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { PgGeminiFileRepository } from "../../../src/infrastructure/db/repositories/PgGeminiFileRepository.ts";
import { geminiFiles, geminiFileUploads, messages } from "../../../src/infrastructure/db/schema.ts";

/**
 * Integration tests for PgGeminiFileRepository.
 *
 * Prerequisites:
 *   - Test DB running: `bun db:test:up && bun db:test:migrate`
 *   - DATABASE_URL env var set to the test DB connection string
 *
 * FK dependency chain:
 *   messages → gemini_files → gemini_file_uploads
 *   gemini_api_keys → gemini_file_uploads
 *
 * Each test group sets up prerequisite rows in beforeAll and cleans up in afterEach.
 */

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgresql://genie_test:genie_test@localhost:5433/genie_test";

const testLogger = pino({ level: "silent" });

let db: ReturnType<typeof createDb>;
let repo: PgGeminiFileRepository;
let keyRepo: PgGeminiApiKeyRepository;

beforeAll(async () => {
    db = createDb(TEST_DB_URL);
    repo = new PgGeminiFileRepository(db, testLogger);
    keyRepo = new PgGeminiApiKeyRepository(db, testLogger);
});

afterEach(async () => {
    // Truncate all dependent tables. gemini_files and gemini_file_uploads cascade
    // from messages and gemini_api_keys respectively.
    await db.execute(
        sql`TRUNCATE TABLE gemini_file_uploads, gemini_files, gemini_api_keys, messages RESTART IDENTITY CASCADE`,
    );
});

afterAll(async () => {
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Inserts a minimal messages row so gemini_files FK constraints are satisfied.
 * Returns the discord_message_id of the inserted row.
 */
async function insertTestMessage(discordMessageId = "test-msg-001"): Promise<{ id: string; discordMessageId: string }> {
    const [row] = await db
        .insert(messages)
        .values({
            discordMessageId,
            repliesToDiscordId: null,
            channelId: "ch-test",
            guildId: "@me",
            role: "human",
            // TYPE COERCION: empty array satisfies the column type for test isolation;
            // actual LangChain message content is irrelevant to these DB tests.
            langchainMessages: [] as unknown as Record<string, unknown>[],
        })
        .returning();
    if (!row) throw new Error("Failed to insert test message");
    return { id: row.id, discordMessageId: row.discordMessageId };
}

/** Inserts a minimal gemini_api_keys row and returns its UUID. */
async function insertTestApiKey(apiKey = "test-api-key", isPaid = false): Promise<string> {
    const record = await keyRepo.upsert({ apiKey, isPaid });
    return record.id;
}

/** Builds a minimal GeminiFile input payload (without id). Requires the messages row UUID as messageId. */
function filePayload(
    messageId: string,
    overrides: Partial<Omit<GeminiFile, "id" | "discordMessageId" | "discordChannelId">> = {},
): Omit<GeminiFile, "id" | "discordMessageId" | "discordChannelId"> {
    return {
        originalGeminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/test-file",
        discordAttachmentId: "att-001",
        discordFilename: "photo.png",
        messageId,
        ...overrides,
    };
}

/** Builds a minimal GeminiFileUpload input payload (without id). */
function uploadPayload(overrides: Partial<Omit<GeminiFileUpload, "id">> = {}): Omit<GeminiFileUpload, "id"> {
    return {
        geminiFileId: "will-be-overridden",
        apiKeyId: "will-be-overridden",
        geminiFileName: "files/test-uuid",
        geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/test-uuid",
        uploadedAt: new Date(),
        ...overrides,
    };
}

/** Inserts a gemini_files row directly and returns the DB row (id + stored columns only). */
async function insertTestFile(
    payload: Omit<GeminiFile, "id" | "discordMessageId" | "discordChannelId">,
): Promise<{ id: string; originalGeminiUrl: string }> {
    const [row] = await db.insert(geminiFiles).values(payload).returning();
    if (!row) throw new Error("Failed to insert test gemini file");
    return row;
}

// ─── findWithUploadStateForKey ──────────────────────────────────────────────

describe("PgGeminiFileRepository.findWithUploadStateForKey", () => {
    test("returns upload: null when no upload exists for the given API key", async () => {
        const msg = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();
        const savedFile = await insertTestFile(filePayload(msg.id));

        // No upload row inserted — LEFT JOIN should yield upload: null
        const result = await repo.findWithUploadStateForKey([savedFile.originalGeminiUrl], apiKeyId);

        expect(result.size).toBe(1);
        const entry = result.get(savedFile.originalGeminiUrl);
        expect(entry).toBeDefined();
        expect(entry?.file.id).toBe(savedFile.id);
        expect(entry?.upload).toBeNull();
    });

    test("returns both file and upload when an upload exists for the given key", async () => {
        const msg = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();
        const savedFile = await insertTestFile(filePayload(msg.id));

        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId,
                geminiFileName: "files/present-uuid",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/present-uuid",
            }),
        );

        const result = await repo.findWithUploadStateForKey([savedFile.originalGeminiUrl], apiKeyId);

        expect(result.size).toBe(1);
        const entry = result.get(savedFile.originalGeminiUrl);
        expect(entry?.file.id).toBe(savedFile.id);
        expect(entry?.upload).not.toBeNull();
        expect(entry?.upload?.geminiFileName).toBe("files/present-uuid");
        expect(entry?.upload?.apiKeyId).toBe(apiKeyId);
    });

    test("returns upload: null for a different API key (project-scoped)", async () => {
        const msg = await insertTestMessage();
        const keyId1 = await insertTestApiKey("key-1");
        const keyId2 = await insertTestApiKey("key-2");
        const savedFile = await insertTestFile(filePayload(msg.id));

        // Upload exists only for key1
        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId: keyId1,
                geminiFileName: "files/key1-upload",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/key1-upload",
            }),
        );

        // Query for key2 — no upload should be found
        const result = await repo.findWithUploadStateForKey([savedFile.originalGeminiUrl], keyId2);

        const entry = result.get(savedFile.originalGeminiUrl);
        expect(entry?.upload).toBeNull();
    });

    test("returns an empty map when no gemini_files rows match the requested URLs", async () => {
        const result = await repo.findWithUploadStateForKey(
            ["https://generativelanguage.googleapis.com/v1beta/files/nonexistent"],
            // any valid uuid
            "6e32a57f-6f48-411d-a4e4-e81d86cbf508",
        );

        expect(result.size).toBe(0);
    });

    test("returns an empty map for an empty URL list", async () => {
        const result = await repo.findWithUploadStateForKey([], "any-key-id");
        expect(result.size).toBe(0);
    });

    test("returns multiple entries when multiple URLs are requested", async () => {
        const msg = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();

        const file1 = await insertTestFile(
            filePayload(msg.id, {
                originalGeminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/multi-1",
            }),
        );
        const file2 = await insertTestFile(
            filePayload(msg.id, {
                originalGeminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/multi-2",
                discordAttachmentId: "att-002",
            }),
        );

        // Upload only file1
        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: file1.id,
                apiKeyId,
                geminiFileName: "files/multi-1-upload",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/multi-1-upload",
            }),
        );

        const result = await repo.findWithUploadStateForKey(
            [file1.originalGeminiUrl, file2.originalGeminiUrl],
            apiKeyId,
        );

        expect(result.size).toBe(2);
        expect(result.get(file1.originalGeminiUrl)?.upload).not.toBeNull();
        expect(result.get(file2.originalGeminiUrl)?.upload).toBeNull();
    });
});

// ─── upsertUpload ───────────────────────────────────────────────────────────

describe("PgGeminiFileRepository.upsertUpload", () => {
    test("inserts a new upload record", async () => {
        const msg = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();
        const savedFile = await insertTestFile(filePayload(msg.id));

        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId,
                geminiFileName: "files/new-upload-uuid",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/new-upload-uuid",
            }),
        );

        const rows = await db.select().from(geminiFileUploads);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.geminiFileId).toBe(savedFile.id);
        expect(rows[0]?.apiKeyId).toBe(apiKeyId);
        expect(rows[0]?.geminiFileName).toBe("files/new-upload-uuid");
    });

    test("ON CONFLICT DO UPDATE: updates geminiUrl and uploadedAt for same (geminiFileId, apiKeyId)", async () => {
        const msg = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();
        const savedFile = await insertTestFile(filePayload(msg.id));

        // Initial upload — use a recent timestamp so the stale-cleanup trigger
        // does not delete it before the second upsert fires the conflict.
        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId,
                geminiFileName: "files/initial-uuid",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/initial-uuid",
                uploadedAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h ago
            }),
        );

        // Re-upload (refresh): new fileName and URL, newer timestamp
        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId,
                geminiFileName: "files/refreshed-uuid",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/refreshed-uuid",
                uploadedAt: new Date(),
            }),
        );

        const rows = await db.select().from(geminiFileUploads);
        // Only one row — the upsert updated in place
        expect(rows).toHaveLength(1);
        expect(rows[0]?.geminiFileName).toBe("files/refreshed-uuid");
        expect(rows[0]?.geminiUrl).toBe("https://generativelanguage.googleapis.com/v1beta/files/refreshed-uuid");
    });

    test("allows separate upload records for the same file with different API keys", async () => {
        const msg = await insertTestMessage();
        const keyId1 = await insertTestApiKey("key-alpha");
        const keyId2 = await insertTestApiKey("key-beta");
        const savedFile = await insertTestFile(filePayload(msg.id));

        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId: keyId1,
                geminiFileName: "files/key-alpha-upload",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/key-alpha-upload",
            }),
        );
        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedFile.id,
                apiKeyId: keyId2,
                geminiFileName: "files/key-beta-upload",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/key-beta-upload",
            }),
        );

        const rows = await db.select().from(geminiFileUploads);
        expect(rows).toHaveLength(2);
    });
});

// ─── saveFiles ───────────────────────────────────────────────────────────────

describe("PgGeminiFileRepository.saveFiles", () => {
    test("returns empty array for empty input without DB round-trip", async () => {
        const result = await repo.saveFiles([]);
        expect(result).toEqual([]);
    });

    test("inserts records and returns UUIDs index-aligned with input", async () => {
        const msg = await insertTestMessage();
        const payload = filePayload(msg.id);

        const result = await repo.saveFiles([payload]);

        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBeDefined();
        expect(typeof result[0]?.id).toBe("string");

        const rows = await db.select().from(geminiFiles);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(result[0]?.id);
    });

    test("ON CONFLICT: returns existing UUID for a duplicate originalGeminiUrl", async () => {
        const msg = await insertTestMessage();
        const payload = filePayload(msg.id);

        const [first] = await repo.saveFiles([payload]);
        const [second] = await repo.saveFiles([payload]);

        expect(second?.id).toBe(first?.id);

        const rows = await db.select().from(geminiFiles);
        expect(rows).toHaveLength(1);
    });

    test("inserts multiple records with distinct originalGeminiUrls", async () => {
        const msg = await insertTestMessage();

        const result = await repo.saveFiles([
            filePayload(msg.id, {
                originalGeminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/file-1",
            }),
            filePayload(msg.id, {
                originalGeminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/file-2",
                discordAttachmentId: "att-002",
            }),
        ]);

        expect(result).toHaveLength(2);
        expect(result[0]?.id).not.toBe(result[1]?.id);

        const rows = await db.select().from(geminiFiles);
        expect(rows).toHaveLength(2);
    });

    test("returned UUIDs can be used as FKs for upsertUpload", async () => {
        const msg = await insertTestMessage();
        const apiKeyId = await insertTestApiKey();
        const saved = await repo.saveFiles([filePayload(msg.id)]);
        const savedId = saved[0]?.id;
        if (!savedId) throw new Error("saveFiles returned no rows");

        await repo.upsertUpload(
            uploadPayload({
                geminiFileId: savedId,
                apiKeyId,
                geminiFileName: "files/fk-test",
                geminiUrl: "https://generativelanguage.googleapis.com/v1beta/files/fk-test",
            }),
        );

        const uploadRows = await db.select().from(geminiFileUploads).where(eq(geminiFileUploads.geminiFileId, savedId));
        expect(uploadRows).toHaveLength(1);
    });
});
