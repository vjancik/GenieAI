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
            firstPageMessageId: sql.placeholder("firstPageMessageId"),
            endOffset: sql.placeholder("endOffset"),
            currentPage: sql.placeholder("currentPage"),
            totalPages: sql.placeholder("totalPages"),
            endedInCodeBlock: sql.placeholder("endedInCodeBlock"),
            codeBlockType: sql.placeholder("codeBlockType"),
        })
        .returning()
        .prepare("message_page_insert");
}

/** Prepared statement: find a message page by the bot Discord message ID currently showing the button. */
function buildFindByBotMessageIdStmt(db: Db) {
    return db
        .select()
        .from(messagePages)
        .where(eq(messagePages.botDiscordMessageId, sql.placeholder("botDiscordMessageId")))
        .limit(1)
        .prepare("message_page_find_by_bot_message_id");
}

/**
 * PostgreSQL implementation of {@link IMessagePageRepository} using Drizzle ORM.
 *
 * Tracks pending "next page" state for paginated bot responses.
 * Each row corresponds to one bot message currently displaying a Next Page button.
 * firstPageMessageId always points to the first page's messages row, where the
 * LangChain content is stored, regardless of which page number this row represents.
 */
export class PgMessagePageRepository implements IMessagePageRepository {
    private readonly stmtInsertPage: ReturnType<typeof buildInsertPageStmt>;
    private readonly stmtFindByBotMessageId: ReturnType<typeof buildFindByBotMessageIdStmt>;

    constructor(
        db: Db,
        private readonly logger: Logger,
    ) {
        this.stmtInsertPage = buildInsertPageStmt(db);
        this.stmtFindByBotMessageId = buildFindByBotMessageIdStmt(db);
    }

    async save(page: Omit<MessagePage, "id" | "createdAt">): Promise<MessagePage> {
        return Sentry.startSpan(
            {
                name: "Save message page",
                op: "db.query",
                attributes: {
                    "db.table": "message_pages",
                    "discord.message_id": page.botDiscordMessageId,
                    "discord.first_page_message_id": page.firstPageMessageId,
                    "app.current_page": page.currentPage,
                    "app.total_pages": page.totalPages,
                },
            },
            async () => {
                try {
                    const [result] = await this.stmtInsertPage.execute({
                        botDiscordMessageId: page.botDiscordMessageId,
                        firstPageMessageId: page.firstPageMessageId,
                        endOffset: page.endOffset,
                        currentPage: page.currentPage,
                        totalPages: page.totalPages,
                        endedInCodeBlock: page.endedInCodeBlock,
                        codeBlockType: page.codeBlockType,
                    });

                    if (!result) {
                        throw new DatabaseError("message_pages insert returned no result");
                    }

                    this.logger.debug(
                        {
                            botDiscordMessageId: page.botDiscordMessageId,
                            firstPageMessageId: page.firstPageMessageId,
                            page: page.currentPage,
                        },
                        "Saved message page",
                    );

                    return result;
                } catch (err) {
                    if (err instanceof DatabaseError) throw err;
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
                    throw new DatabaseError("Failed to find message page", err);
                }
            },
        );
    }
}
