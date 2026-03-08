import { eq, inArray } from "drizzle-orm";
import type { IGeminiFileRepository } from "../../../application/ports/IGeminiFileRepository.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { GeminiFileUpload } from "../../../domain/message/GeminiFileUpload.ts";
import type { Db } from "../connection.ts";
import { geminiFileUploads } from "../schema.ts";

/**
 * PostgreSQL implementation of {@link IGeminiFileRepository} using Drizzle ORM.
 *
 * Records are keyed by `originalGeminiUrl` — the immutable URI from the first
 * upload. This URL is stored in LangChain message content blocks and never changes,
 * allowing history scans to look up current file state without mutating
 * the persisted `langchain_messages` column.
 */
export class PgGeminiFileRepository implements IGeminiFileRepository {
    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {}

    async save(
        record: Omit<GeminiFileUpload, "id">,
    ): Promise<GeminiFileUpload> {
        try {
            const [result] = await this.db
                .insert(geminiFileUploads)
                .values({
                    originalGeminiUrl: record.originalGeminiUrl,
                    geminiFileName: record.geminiFileName,
                    geminiUrl: record.geminiUrl,
                    uploadedAt: record.uploadedAt,
                    discordAttachmentId: record.discordAttachmentId,
                    discordFilename: record.discordFilename,
                    messageDiscordId: record.messageDiscordId,
                })
                .returning();

            if (!result) {
                throw new DatabaseError(
                    "Gemini file upload insert returned no result",
                );
            }

            this.logger.debug(
                {
                    originalGeminiUrl: record.originalGeminiUrl,
                    geminiFileName: record.geminiFileName,
                },
                "Saved Gemini file upload record",
            );

            return result;
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError("Failed to save Gemini file upload", err);
        }
    }

    async updateAfterRefresh(
        originalGeminiUrl: string,
        update: Pick<
            GeminiFileUpload,
            "geminiFileName" | "geminiUrl" | "uploadedAt"
        >,
    ): Promise<void> {
        try {
            await this.db
                .update(geminiFileUploads)
                .set({
                    geminiFileName: update.geminiFileName,
                    geminiUrl: update.geminiUrl,
                    uploadedAt: update.uploadedAt,
                })
                .where(
                    eq(geminiFileUploads.originalGeminiUrl, originalGeminiUrl),
                );

            this.logger.debug(
                {
                    originalGeminiUrl,
                    newGeminiFileName: update.geminiFileName,
                },
                "Updated Gemini file upload record after refresh",
            );
        } catch (err) {
            throw new DatabaseError(
                "Failed to update Gemini file upload after refresh",
                err,
            );
        }
    }

    async findByOriginalUrls(
        originalGeminiUrls: string[],
    ): Promise<Map<string, GeminiFileUpload>> {
        if (originalGeminiUrls.length === 0) {
            return new Map();
        }

        try {
            const rows = await this.db
                .select()
                .from(geminiFileUploads)
                .where(
                    inArray(
                        geminiFileUploads.originalGeminiUrl,
                        originalGeminiUrls,
                    ),
                );

            const result = new Map<string, GeminiFileUpload>();
            for (const row of rows) {
                const domain = row;
                result.set(domain.originalGeminiUrl, domain);
            }
            return result;
        } catch (err) {
            throw new DatabaseError(
                "Failed to look up Gemini file uploads by original URL",
                err,
            );
        }
    }

    // private rowToDomain(
    //     row: typeof geminiFileUploads.$inferSelect,
    // ): GeminiFileUpload {
    //     return {
    //         id: row.id,
    //         originalGeminiUrl: row.originalGeminiUrl,
    //         geminiFileName: row.geminiFileName,
    //         geminiUrl: row.geminiUrl,
    //         uploadedAt: row.uploadedAt,
    //         discordAttachmentId: row.discordAttachmentId,
    //         discordFilename: row.discordFilename,
    //         messageDiscordId: row.messageDiscordId,
    //     };
    // }
}
