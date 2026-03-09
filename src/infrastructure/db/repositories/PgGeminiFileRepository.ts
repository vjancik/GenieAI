import { and, eq, inArray } from "drizzle-orm";
import type { IGeminiFileRepository } from "../../../application/ports/IGeminiFileRepository.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { GeminiFile } from "../../../domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../../domain/message/GeminiFileUpload.ts";
import type { Db } from "../connection.ts";
import { geminiFiles, geminiFileUploads } from "../schema.ts";

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
 */
export class PgGeminiFileRepository implements IGeminiFileRepository {
    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {}

    /**
     * Idempotently saves a permanent file anchor.
     *
     * Uses ON CONFLICT DO NOTHING so concurrent inserts of the same
     * `originalGeminiUrl` are safe. Falls back to a SELECT when a conflict
     * occurs so the caller always receives the persisted record with its UUID.
     */
    async saveFile(record: Omit<GeminiFile, "id">): Promise<GeminiFile> {
        try {
            const [inserted] = await this.db
                .insert(geminiFiles)
                .values({
                    originalGeminiUrl: record.originalGeminiUrl,
                    discordAttachmentId: record.discordAttachmentId,
                    discordFilename: record.discordFilename,
                    messageDiscordId: record.messageDiscordId,
                })
                .onConflictDoNothing()
                .returning();

            if (inserted) {
                this.logger.debug(
                    { originalGeminiUrl: record.originalGeminiUrl },
                    "Saved new Gemini file anchor record",
                );
                return {
                    id: inserted.id,
                    originalGeminiUrl: inserted.originalGeminiUrl,
                    discordAttachmentId: inserted.discordAttachmentId,
                    discordFilename: inserted.discordFilename,
                    messageDiscordId: inserted.messageDiscordId,
                };
            }

            // Conflict case: row already exists — fetch it by the unique URL
            const [existing] = await this.db
                .select()
                .from(geminiFiles)
                .where(
                    eq(geminiFiles.originalGeminiUrl, record.originalGeminiUrl),
                );

            if (!existing) {
                throw new DatabaseError(
                    "Failed to save or retrieve GeminiFile record after ON CONFLICT DO NOTHING",
                );
            }

            this.logger.debug(
                {
                    originalGeminiUrl: record.originalGeminiUrl,
                    existingId: existing.id,
                },
                "GeminiFile anchor already exists; using existing record",
            );

            return {
                id: existing.id,
                originalGeminiUrl: existing.originalGeminiUrl,
                discordAttachmentId: existing.discordAttachmentId,
                discordFilename: existing.discordFilename,
                messageDiscordId: existing.messageDiscordId,
            };
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError("Failed to save Gemini file anchor", err);
        }
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
    ): Promise<
        Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>
    > {
        if (originalUrls.length === 0) {
            return new Map();
        }

        try {
            const rows = await this.db
                .select({
                    // gemini_files columns (always present)
                    fileId: geminiFiles.id,
                    fileOriginalGeminiUrl: geminiFiles.originalGeminiUrl,
                    fileDiscordAttachmentId: geminiFiles.discordAttachmentId,
                    fileDiscordFilename: geminiFiles.discordFilename,
                    fileMessageDiscordId: geminiFiles.messageDiscordId,
                    // gemini_file_uploads columns (null if no upload for this key)
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
                        eq(geminiFileUploads.apiKeyId, apiKeyId),
                    ),
                )
                .where(inArray(geminiFiles.originalGeminiUrl, originalUrls));

            const result = new Map<
                string,
                { file: GeminiFile; upload: GeminiFileUpload | null }
            >();

            for (const row of rows) {
                const file: GeminiFile = {
                    id: row.fileId,
                    originalGeminiUrl: row.fileOriginalGeminiUrl,
                    discordAttachmentId: row.fileDiscordAttachmentId,
                    discordFilename: row.fileDiscordFilename,
                    messageDiscordId: row.fileMessageDiscordId,
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
            throw new DatabaseError(
                "Failed to look up Gemini file upload state for key",
                err,
            );
        }
    }

    /**
     * Inserts or updates the upload record for a `(geminiFileId, apiKeyId)` pair.
     *
     * The BEFORE INSERT trigger on `gemini_file_uploads` fires here, cleaning
     * any rows older than 48 hours before the new row is inserted.
     */
    async upsertUpload(
        record: Omit<GeminiFileUpload, "id">,
    ): Promise<GeminiFileUpload> {
        try {
            const [result] = await this.db
                .insert(geminiFileUploads)
                .values({
                    geminiFileId: record.geminiFileId,
                    apiKeyId: record.apiKeyId,
                    geminiFileName: record.geminiFileName,
                    geminiUrl: record.geminiUrl,
                    uploadedAt: record.uploadedAt,
                })
                .onConflictDoUpdate({
                    target: [
                        geminiFileUploads.geminiFileId,
                        geminiFileUploads.apiKeyId,
                    ],
                    set: {
                        geminiFileName: record.geminiFileName,
                        geminiUrl: record.geminiUrl,
                        uploadedAt: record.uploadedAt,
                    },
                })
                .returning();

            if (!result) {
                throw new DatabaseError(
                    "Gemini file upload upsert returned no result",
                );
            }

            this.logger.debug(
                {
                    geminiFileId: record.geminiFileId,
                    apiKeyId: record.apiKeyId,
                    geminiFileName: record.geminiFileName,
                },
                "Upserted Gemini file upload record",
            );

            return {
                id: result.id,
                geminiFileId: result.geminiFileId,
                apiKeyId: result.apiKeyId,
                geminiFileName: result.geminiFileName,
                geminiUrl: result.geminiUrl,
                uploadedAt: result.uploadedAt,
            };
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError(
                "Failed to upsert Gemini file upload record",
                err,
            );
        }
    }
}
