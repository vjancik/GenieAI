import * as Sentry from "@sentry/bun";
import { and, eq, sql } from "drizzle-orm";
import type { IGeminiFileRepository } from "../../../application/ports/IGeminiFileRepository.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { GeminiFile } from "../../../domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../../domain/message/GeminiFileUpload.ts";
import type { Db } from "../connection.ts";
import { pgTextArray } from "../pgTextArray.ts";
import { geminiFiles, geminiFileUploads } from "../schema.ts";

/**
 * Prepared statement: LEFT JOIN gemini_files with gemini_file_uploads for a given
 * set of original URLs and a specific API key.
 *
 * Uses `= ANY($urls)` instead of `IN (...)` so the query structure is fixed regardless
 * of how many URLs are looked up — a single `text[]` placeholder replaces the dynamic list.
 * At execute time, `urls` receives a {@link pgTextArray} value.
 */
function buildFindWithUploadStateStmt(db: Db) {
    return db
        .select({
            fileId: geminiFiles.id,
            fileOriginalGeminiUrl: geminiFiles.originalGeminiUrl,
            fileDiscordAttachmentId: geminiFiles.discordAttachmentId,
            fileDiscordFilename: geminiFiles.discordFilename,
            fileMessageId: geminiFiles.messageId,
            fileDiscordMessageId: geminiFiles.discordMessageId,
            uploadId: geminiFileUploads.id,
            uploadGeminiFileId: geminiFileUploads.geminiFileId,
            uploadApiKeyId: geminiFileUploads.apiKeyId,
            uploadGeminiFileName: geminiFileUploads.geminiFileName,
            uploadGeminiUrl: geminiFileUploads.geminiUrl,
            uploadUploadedAt: geminiFileUploads.uploadedAt,
        })
        .from(geminiFiles)
        .leftJoin(
            geminiFileUploads,
            and(
                eq(geminiFileUploads.geminiFileId, geminiFiles.id),
                eq(geminiFileUploads.apiKeyId, sql.placeholder("apiKeyId")),
            ),
        )
        .where(eq(geminiFiles.originalGeminiUrl, sql`ANY(${sql.placeholder("urls")})`))
        .prepare("gemini_file_find_with_upload_state");
}

/**
 * Prepared statement: upsert a gemini_file_uploads row for a (geminiFileId, apiKeyId) pair.
 *
 * Uses EXCLUDED.<col> in the conflict set so the query structure is fully static
 * and the prepared statement can be reused across all calls.
 */
function buildUpsertUploadStmt(db: Db) {
    return db
        .insert(geminiFileUploads)
        .values({
            geminiFileId: sql.placeholder("geminiFileId"),
            apiKeyId: sql.placeholder("apiKeyId"),
            geminiFileName: sql.placeholder("geminiFileName"),
            geminiUrl: sql.placeholder("geminiUrl"),
            uploadedAt: sql.placeholder("uploadedAt"),
        })
        .onConflictDoUpdate({
            target: [geminiFileUploads.geminiFileId, geminiFileUploads.apiKeyId],
            set: {
                // EXCLUDED refers to the row proposed for insertion — standard PostgreSQL upsert pattern.
                geminiFileName: sql`EXCLUDED.gemini_file_name`,
                geminiUrl: sql`EXCLUDED.gemini_url`,
                uploadedAt: sql`EXCLUDED.uploaded_at`,
            },
        })
        .prepare("gemini_file_upload_upsert");
}

/**
 * PostgreSQL implementation of {@link IGeminiFileRepository} using Drizzle ORM.
 *
 * Manages two tables:
 * - `gemini_files` — permanent anchors, one row per Discord attachment ever uploaded.
 *   Rows are never deleted (except via ON DELETE CASCADE from the messages FK).
 * - `gemini_file_uploads` — ephemeral per-(file, api_key) upload tracking.
 *   Rows are cleaned by a BEFORE INSERT trigger when they exceed 48h.
 *
 * The two-table design preserves Discord context (attachment ID, filename, message ID)
 * even after stale upload rows are trigger-cleaned, allowing re-upload without
 * scanning LangChain message JSON.
 *
 * All queries use prepared statements cached on construction, reducing per-call
 * planning overhead. Dynamic array parameters use {@link pgTextArray} to produce
 * a `text[]` value compatible with `= ANY($1)` / `!= ALL($1)` without expanding
 * the parameter list.
 */
export class PgGeminiFileRepository implements IGeminiFileRepository {
    private readonly stmtFindWithUploadState: ReturnType<typeof buildFindWithUploadStateStmt>;
    private readonly stmtUpsertUpload: ReturnType<typeof buildUpsertUploadStmt>;

    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {
        this.stmtFindWithUploadState = buildFindWithUploadStateStmt(db);
        this.stmtUpsertUpload = buildUpsertUploadStmt(db);
    }

    /**
     * Batch-saves permanent file anchors.
     *
     * Uses ON CONFLICT (original_gemini_url) DO UPDATE SET id = gemini_files.id (no-op)
     * so that `.returning()` always yields every row — pre-existing rows are included
     * via the dummy update, eliminating the need for N fallback SELECTs.
     *
     * Empty input returns immediately without a DB round-trip.
     */
    async saveFiles(records: Omit<GeminiFile, "id">[]): Promise<{ id: string }[]> {
        if (records.length === 0) return [];
        return Sentry.startSpan(
            {
                name: "Batch save Gemini file anchors",
                op: "db.query",
                attributes: { "db.table": "gemini_files", "app.batch_size": records.length },
            },
            async () => {
                try {
                    const rows = await this.db
                        .insert(geminiFiles)
                        .values(
                            records.map((r) => ({
                                originalGeminiUrl: r.originalGeminiUrl,
                                discordAttachmentId: r.discordAttachmentId,
                                discordFilename: r.discordFilename,
                                messageId: r.messageId,
                                discordMessageId: r.discordMessageId,
                            })),
                        )
                        .onConflictDoUpdate({
                            target: geminiFiles.originalGeminiUrl,
                            // No-op update: id = id forces Postgres to include the existing row
                            // in RETURNING, so callers always get the UUID without a fallback SELECT.
                            set: { id: geminiFiles.id },
                        })
                        .returning({ id: geminiFiles.id });

                    this.logger.debug({ batchSize: records.length }, "Batch saved Gemini file anchor records");

                    return rows;
                } catch (err) {
                    throw new DatabaseError("Failed to batch save Gemini file anchors", err);
                }
            },
        );
    }

    /**
     * LEFT JOINs `gemini_files` with `gemini_file_uploads` for the given
     * original Gemini URLs and a specific API key.
     *
     * Always returns a `file` entry (Discord context is never deleted with the
     * anchor row). Returns `upload: null` when the file has never been uploaded
     * for the specified API key or the upload row was cleaned by the trigger.
     *
     * Uses a partial select to avoid Drizzle join namespace ambiguity and
     * produce a flat, predictably typed result.
     */
    async findWithUploadStateForKey(
        originalUrls: string[],
        apiKeyId: string,
    ): Promise<Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>> {
        if (originalUrls.length === 0) {
            return new Map();
        }

        return Sentry.startSpan(
            {
                name: "Find Gemini file upload state for key",
                op: "db.query",
                attributes: {
                    "db.table": "gemini_files",
                    "gemini.url_count": originalUrls.length,
                    "llm.api_key_id": apiKeyId,
                },
            },
            async (span) => {
                try {
                    const rows = await this.stmtFindWithUploadState.execute({
                        // pgTextArray produces a text[] literal accepted by = ANY($1) without
                        // expanding the parameter count — the query shape stays fixed regardless
                        // of how many URLs are passed.
                        urls: pgTextArray(originalUrls),
                        apiKeyId,
                    });

                    span.setAttribute("db.result_count", rows.length);

                    const result = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();

                    for (const row of rows) {
                        const file: GeminiFile = {
                            id: row.fileId,
                            originalGeminiUrl: row.fileOriginalGeminiUrl,
                            discordAttachmentId: row.fileDiscordAttachmentId,
                            discordFilename: row.fileDiscordFilename,
                            messageId: row.fileMessageId,
                            discordMessageId: row.fileDiscordMessageId,
                        };

                        // Presence of uploadId indicates a matching upload row was found
                        const upload: GeminiFileUpload | null =
                            row.uploadId !== null &&
                            row.uploadGeminiFileId !== null &&
                            row.uploadApiKeyId !== null &&
                            row.uploadGeminiFileName !== null &&
                            row.uploadGeminiUrl !== null &&
                            row.uploadUploadedAt !== null
                                ? {
                                      id: row.uploadId,
                                      geminiFileId: row.uploadGeminiFileId,
                                      apiKeyId: row.uploadApiKeyId,
                                      geminiFileName: row.uploadGeminiFileName,
                                      geminiUrl: row.uploadGeminiUrl,
                                      uploadedAt: row.uploadUploadedAt,
                                  }
                                : null;

                        result.set(file.originalGeminiUrl, { file, upload });
                    }

                    return result;
                } catch (err) {
                    throw new DatabaseError("Failed to look up Gemini file upload state for key", err);
                }
            },
        );
    }

    /**
     * Inserts or updates the upload record for a `(geminiFileId, apiKeyId)` pair.
     *
     * The BEFORE INSERT trigger on `gemini_file_uploads` fires here, cleaning
     * any rows older than 48 hours before the new row is inserted.
     */
    async upsertUpload(record: Omit<GeminiFileUpload, "id">): Promise<void> {
        return Sentry.startSpan(
            {
                name: "Upsert Gemini file upload record",
                op: "db.query",
                attributes: {
                    "db.table": "gemini_file_uploads",
                    "llm.api_key_id": record.apiKeyId,
                },
            },
            async () => {
                try {
                    await this.stmtUpsertUpload.execute({
                        geminiFileId: record.geminiFileId,
                        apiKeyId: record.apiKeyId,
                        geminiFileName: record.geminiFileName,
                        geminiUrl: record.geminiUrl,
                        uploadedAt: record.uploadedAt,
                    });

                    this.logger.debug(
                        {
                            geminiFileId: record.geminiFileId,
                            apiKeyId: record.apiKeyId,
                            geminiFileName: record.geminiFileName,
                        },
                        "Upserted Gemini file upload record",
                    );
                } catch (err) {
                    throw new DatabaseError("Failed to upsert Gemini file upload record", err);
                }
            },
        );
    }

    /**
     * Batch inserts or updates upload records for multiple (geminiFileId, apiKeyId) pairs.
     *
     * Applies the same ON CONFLICT logic as {@link upsertUpload}.
     * Empty input returns immediately without a DB round-trip.
     */
    async upsertUploads(records: Omit<GeminiFileUpload, "id">[]): Promise<void> {
        if (records.length === 0) return;
        return Sentry.startSpan(
            {
                name: "Batch upsert Gemini file upload records",
                op: "db.query",
                attributes: { "db.table": "gemini_file_uploads", "app.batch_size": records.length },
            },
            async () => {
                try {
                    await this.db
                        .insert(geminiFileUploads)
                        .values(
                            records.map((r) => ({
                                geminiFileId: r.geminiFileId,
                                apiKeyId: r.apiKeyId,
                                geminiFileName: r.geminiFileName,
                                geminiUrl: r.geminiUrl,
                                uploadedAt: r.uploadedAt,
                            })),
                        )
                        .onConflictDoUpdate({
                            target: [geminiFileUploads.geminiFileId, geminiFileUploads.apiKeyId],
                            set: {
                                geminiFileName: sql`EXCLUDED.gemini_file_name`,
                                geminiUrl: sql`EXCLUDED.gemini_url`,
                                uploadedAt: sql`EXCLUDED.uploaded_at`,
                            },
                        });

                    this.logger.debug({ batchSize: records.length }, "Batch upserted Gemini file upload records");
                } catch (err) {
                    throw new DatabaseError("Failed to batch upsert Gemini file upload records", err);
                }
            },
        );
    }
}
