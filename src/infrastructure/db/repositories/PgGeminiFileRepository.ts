import * as Sentry from "@sentry/bun";
import { and, eq, sql } from "drizzle-orm";
import type { IGeminiFileRepository } from "../../../application/ports/IGeminiFileRepository.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { GeminiFile } from "../../../domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../../domain/message/GeminiFileUpload.ts";
import type { Db } from "../connection.ts";
import { pgTextArray } from "../pgTextArray.ts";
import { geminiFiles, geminiFileUploads, messages } from "../schema.ts";

/**
 * Prepared statement for {@link PgGeminiFileRepository.findByOriginalUrl}.
 *
 * Looks up gemini_files by original_gemini_url (discord:// token URLs) and LEFT JOINs
 * the upload record for the specified API key.
 */
function buildFindByOriginalUrlStmt(db: Db) {
    return db
        .select({
            fileId: geminiFiles.id,
            fileOriginalGeminiUrl: geminiFiles.originalGeminiUrl,
            fileSourceType: geminiFiles.sourceType,
            fileDiscordAttachmentId: geminiFiles.discordAttachmentId,
            fileDiscordFilename: geminiFiles.discordFilename,
            fileEmbedIndex: geminiFiles.embedIndex,
            fileEmbedMediaKey: geminiFiles.embedMediaKey,
            fileMessageId: geminiFiles.messageId,
            msgDiscordMessageId: messages.discordMessageId,
            msgChannelId: messages.channelId,
            uploadId: geminiFileUploads.id,
            uploadGeminiFileId: geminiFileUploads.geminiFileId,
            uploadApiKeyId: geminiFileUploads.apiKeyId,
            uploadGeminiFileName: geminiFileUploads.geminiFileName,
            uploadGeminiUrl: geminiFileUploads.geminiUrl,
            uploadUploadedAt: geminiFileUploads.uploadedAt,
        })
        .from(geminiFiles)
        .innerJoin(messages, eq(messages.id, geminiFiles.messageId))
        .leftJoin(
            geminiFileUploads,
            and(
                eq(geminiFileUploads.geminiFileId, geminiFiles.id),
                eq(geminiFileUploads.apiKeyId, sql.placeholder("apiKeyId")),
            ),
        )
        .where(eq(geminiFiles.originalGeminiUrl, sql`ANY(${sql.placeholder("originalUrls")})`))
        .prepare("gemini_file_find_by_original_url");
}

// LEGACY: Legacy query for pre-refactor pre-discord-token URLs baked in Langchain messages.
//         Not used for new conversations.
// NOTE: I hate this with a passion, but this is a limitation introduced by loss of state
//       due to how Langgraph state is structured. To override it with extra context from DB
//       would mean losing message formatting in LangSmith. For now this is a painful but acceptable trade-off.
/**
 * Prepared statement for {@link PgGeminiFileRepository.findByUploadUrl}.
 *
 * Same shape as {@link buildFindByOriginalUrlStmt}: FROM gemini_files, LEFT JOIN
 * gemini_file_uploads for the current API key's upload state.
 *
 * WHERE uses an EXISTS subquery to find anchors that have *any* upload row matching
 * the requested Gemini URLs — regardless of which API key uploaded them. This allows
 * the caller to locate anchors from fileUri blocks even when the current key has never
 * uploaded the file (upload will be null, triggering a re-upload).
 *
 * A correlated scalar subquery also retrieves the specific matched Gemini URL so the
 * caller can key the result map by the URL it searched for.
 */
function buildFindByUploadUrlStmt(db: Db) {
    return db
        .select({
            fileId: geminiFiles.id,
            fileOriginalGeminiUrl: geminiFiles.originalGeminiUrl,
            fileSourceType: geminiFiles.sourceType,
            fileDiscordAttachmentId: geminiFiles.discordAttachmentId,
            fileDiscordFilename: geminiFiles.discordFilename,
            fileEmbedIndex: geminiFiles.embedIndex,
            fileEmbedMediaKey: geminiFiles.embedMediaKey,
            fileMessageId: geminiFiles.messageId,
            msgDiscordMessageId: messages.discordMessageId,
            msgChannelId: messages.channelId,
            uploadId: geminiFileUploads.id,
            uploadGeminiFileId: geminiFileUploads.geminiFileId,
            uploadApiKeyId: geminiFileUploads.apiKeyId,
            uploadGeminiFileName: geminiFileUploads.geminiFileName,
            uploadGeminiUrl: geminiFileUploads.geminiUrl,
            uploadUploadedAt: geminiFileUploads.uploadedAt,
            // Scalar subquery: retrieve the matched URL from the any-key upload row so the
            // caller can key the result map by the URL it searched for, independent of
            // whether the current-key LEFT JOIN found a record.
            matchedGeminiUrl: sql<string>`(
                SELECT u.gemini_url FROM gemini_file_uploads u
                WHERE u.gemini_file_id = ${geminiFiles.id}
                  AND u.gemini_url = ANY(${sql.placeholder("geminiUrls")})
                LIMIT 1
            )`,
        })
        .from(geminiFiles)
        .innerJoin(messages, eq(messages.id, geminiFiles.messageId))
        .leftJoin(
            geminiFileUploads,
            and(
                eq(geminiFileUploads.geminiFileId, geminiFiles.id),
                eq(geminiFileUploads.apiKeyId, sql.placeholder("apiKeyId")),
            ),
        )
        .where(
            sql`EXISTS (
                SELECT 1 FROM gemini_file_uploads u
                WHERE u.gemini_file_id = ${geminiFiles.id}
                  AND u.gemini_url = ANY(${sql.placeholder("geminiUrls")})
            )`,
        )
        .prepare("gemini_file_find_by_upload_url");
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

type UploadStateRow = {
    fileId: string;
    fileOriginalGeminiUrl: string;
    fileSourceType: GeminiFile["sourceType"];
    fileDiscordAttachmentId: string | null;
    fileDiscordFilename: string | null;
    fileEmbedIndex: number | null;
    fileEmbedMediaKey: GeminiFile["embedMediaKey"];
    fileMessageId: string;
    msgDiscordMessageId: string;
    msgChannelId: string;
    uploadId: string | null;
    uploadGeminiFileId: string | null;
    uploadApiKeyId: string | null;
    uploadGeminiFileName: string | null;
    uploadGeminiUrl: string | null;
    uploadUploadedAt: Date | null;
};

/** Constructs typed {@link GeminiFile} and {@link GeminiFileUpload} objects from a flat query row. */
function buildFileAndUpload(row: UploadStateRow): { file: GeminiFile; upload: GeminiFileUpload | null } {
    const file: GeminiFile = {
        id: row.fileId,
        originalGeminiUrl: row.fileOriginalGeminiUrl,
        sourceType: row.fileSourceType,
        discordAttachmentId: row.fileDiscordAttachmentId,
        discordFilename: row.fileDiscordFilename,
        embedIndex: row.fileEmbedIndex,
        embedMediaKey: row.fileEmbedMediaKey,
        messageId: row.fileMessageId,
        discordMessageId: row.msgDiscordMessageId,
        discordChannelId: row.msgChannelId,
    };
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
    return { file, upload };
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
    private readonly stmtFindByOriginalUrl: ReturnType<typeof buildFindByOriginalUrlStmt>;
    private readonly stmtFindByUploadUrl: ReturnType<typeof buildFindByUploadUrlStmt>;
    private readonly stmtUpsertUpload: ReturnType<typeof buildUpsertUploadStmt>;

    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {
        this.stmtFindByOriginalUrl = buildFindByOriginalUrlStmt(db);
        this.stmtFindByUploadUrl = buildFindByUploadUrlStmt(db);
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
    async saveFiles(
        records: Omit<GeminiFile, "id" | "discordMessageId" | "discordChannelId">[],
    ): Promise<{ id: string }[]> {
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
                                sourceType: r.sourceType,
                                discordAttachmentId: r.discordAttachmentId,
                                discordFilename: r.discordFilename,
                                embedIndex: r.embedIndex,
                                embedMediaKey: r.embedMediaKey,
                                messageId: r.messageId,
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

    async findByOriginalUrl(
        originalUrls: string[],
        apiKeyId: string,
    ): Promise<Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>> {
        if (originalUrls.length === 0) return new Map();

        return Sentry.startSpan(
            {
                name: "Find Gemini files by original URL",
                op: "db.query",
                attributes: {
                    "db.table": "gemini_files",
                    "gemini.url_count": originalUrls.length,
                    "llm.api_key_id": apiKeyId,
                },
            },
            async (span) => {
                try {
                    const rows = await this.stmtFindByOriginalUrl.execute({
                        originalUrls: pgTextArray(originalUrls),
                        apiKeyId,
                    });
                    span.setAttribute("db.result_count", rows.length);
                    const result = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();
                    for (const row of rows) {
                        const { file, upload } = buildFileAndUpload(row);
                        result.set(file.originalGeminiUrl, { file, upload });
                    }
                    return result;
                } catch (err) {
                    throw new DatabaseError("Failed to look up Gemini files by original URL", err);
                }
            },
        );
    }

    async findByUploadUrl(
        geminiUrls: string[],
        apiKeyId: string,
    ): Promise<Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>> {
        if (geminiUrls.length === 0) return new Map();

        return Sentry.startSpan(
            {
                name: "Find Gemini files by upload URL",
                op: "db.query",
                attributes: {
                    "db.table": "gemini_file_uploads",
                    "gemini.url_count": geminiUrls.length,
                    "llm.api_key_id": apiKeyId,
                },
            },
            async (span) => {
                try {
                    const rows = await this.stmtFindByUploadUrl.execute({
                        geminiUrls: pgTextArray(geminiUrls),
                        apiKeyId,
                    });
                    span.setAttribute("db.result_count", rows.length);
                    const result = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();
                    for (const row of rows) {
                        const { file, upload } = buildFileAndUpload(row);
                        // matchedGeminiUrl is always non-null here — it's the WHERE column
                        // biome-ignore lint/style/noNonNullAssertion: guaranteed by WHERE gemini_url = ANY(...)
                        result.set(row.matchedGeminiUrl!, { file, upload });
                    }
                    return result;
                } catch (err) {
                    throw new DatabaseError("Failed to look up Gemini files by upload URL", err);
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
