import * as Sentry from "@sentry/bun";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { IMessagePageRepository, MessagePage } from "../../../domain/message/MessagePage.ts";
import type { Db } from "../connection.ts";
import { messagePages } from "../schema.ts";

/** Prepared statement: insert a new message page row and return it. */
function buildInsertPageStmt(db: Db) {
    return db
        .insert(messagePages)
        .values({
            botDiscordMessageId: sql.placeholder("botDiscordMessageId"),
            endOffset: sql.placeholder("endOffset"),
            currentPage: sql.placeholder("currentPage"),
            totalPages: sql.placeholder("totalPages"),
        })
        .returning()
        .prepare("message_page_insert");
}

/** Prepared statement: find a message page by its bot Discord message ID. */
function buildFindByBotMessageIdStmt(db: Db) {
    return db
        .select()
        .from(messagePages)
        .where(eq(messagePages.botDiscordMessageId, sql.placeholder("botDiscordMessageId")))
        .limit(1)
        .prepare("message_page_find_by_bot_message_id");
}

/** Prepared statement: delete a message page by its primary key. */
function buildDeleteByIdStmt(db: Db) {
    return db
        .delete(messagePages)
        .where(eq(messagePages.id, sql.placeholder("id")))
        .prepare("message_page_delete_by_id");
}

/**
 * PostgreSQL implementation of {@link IMessagePageRepository} using Drizzle ORM.
 *
 * Tracks pending "next page" state for paginated bot responses.
 * Each row corresponds to one bot message that currently displays a Next Page button.
 * Rows are deleted after the next page is successfully delivered.
 */
export class PgMessagePageRepository implements IMessagePageRepository {
    private readonly stmtInsertPage: ReturnType<typeof buildInsertPageStmt>;
    private readonly stmtFindByBotMessageId: ReturnType<typeof buildFindByBotMessageIdStmt>;
    private readonly stmtDeleteById: ReturnType<typeof buildDeleteByIdStmt>;

    constructor(
        db: Db,
        private readonly logger: Logger,
    ) {
        this.stmtInsertPage = buildInsertPageStmt(db);
        this.stmtFindByBotMessageId = buildFindByBotMessageIdStmt(db);
        this.stmtDeleteById = buildDeleteByIdStmt(db);
    }

    async save(page: Omit<MessagePage, "id" | "createdAt">): Promise<MessagePage> {
        return Sentry.startSpan(
            {
                name: "Save message page",
                op: "db.query",
                attributes: {
                    "db.table": "message_pages",
                    "discord.message_id": page.botDiscordMessageId,
                    "app.current_page": page.currentPage,
                    "app.total_pages": page.totalPages,
                },
            },
            async () => {
                try {
                    const [result] = await this.stmtInsertPage.execute({
                        botDiscordMessageId: page.botDiscordMessageId,
                        endOffset: page.endOffset,
                        currentPage: page.currentPage,
                        totalPages: page.totalPages,
                    });

                    if (!result) {
                        throw new DatabaseError("message_pages insert returned no result");
                    }

                    this.logger.debug(
                        { botDiscordMessageId: page.botDiscordMessageId, page: page.currentPage },
                        "Saved message page",
                    );

                    return result;
                } catch (err) {
                    if (err instanceof DatabaseError) throw err;
                    Sentry.captureException(err);
                    throw new DatabaseError("Failed to save message page", err);
                }
            },
        );
    }

    async findByBotMessageId(botDiscordMessageId: string): Promise<MessagePage | null> {
        return Sentry.startSpan(
            {
                name: "Find message page by bot message ID",
                op: "db.query",
                attributes: {
                    "db.table": "message_pages",
                    "discord.message_id": botDiscordMessageId,
                },
            },
            async () => {
                try {
                    const [result] = await this.stmtFindByBotMessageId.execute({ botDiscordMessageId });
                    return result ?? null;
                } catch (err) {
                    Sentry.captureException(err);
                    throw new DatabaseError("Failed to find message page", err);
                }
            },
        );
    }

    async delete(id: string): Promise<void> {
        return Sentry.startSpan(
            {
                name: "Delete message page",
                op: "db.query",
                attributes: { "db.table": "message_pages", "db.id": id },
            },
            async () => {
                try {
                    await this.stmtDeleteById.execute({ id });
                    this.logger.debug({ id }, "Deleted message page");
                } catch (err) {
                    Sentry.captureException(err);
                    throw new DatabaseError("Failed to delete message page", err);
                }
            },
        );
    }
}
