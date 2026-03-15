import * as Sentry from "@sentry/bun";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { IGetNextPageQuery, NextPageData } from "../../../application/ports/IGetNextPageQuery.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { DiscordMessage } from "../../../domain/message/Message.ts";
import type { Db } from "../connection.ts";
import { messagePages, messages } from "../schema.ts";

/**
 * Builds a prepared statement that resolves a bot message Discord snowflake to the
 * combined page state + LangChain content needed by {@link GetNextPageUseCase}:
 *
 *   message_pages mp
 *     JOIN messages bot  ON bot.id  = mp.message_id          -- resolves snowflake → UUID
 *     JOIN messages fp   ON fp.id   = mp.first_page_message_id  -- fetches LangChain content
 *   WHERE bot.guild_id = $guildId
 *     AND bot.channel_id = $channelId
 *     AND bot.discord_message_id = $discordMessageId
 *
 * The composite unique index on messages(guild_id, channel_id, discord_message_id)
 * makes the bot row lookup an index seek. The unique index on message_pages(message_id)
 * makes the page state join an index seek too.
 *
 * Two aliases of the messages table are required: `bot` for the row identified by the
 * Discord snowflake triple, and `fp` (first page) for the row holding the LangChain content.
 *
 * langchain_messages is a JSON column; Bun's SQL driver may return it as either a
 * pre-parsed JS value or a raw JSON string — both cases are handled defensively.
 */
function buildGetNextPageStmt(db: Db) {
    const bot = alias(messages, "bot");
    const fp = alias(messages, "fp");

    return db
        .select({
            pageStateId: messagePages.id,
            firstPageMessageId: messagePages.firstPageMessageId,
            endOffset: messagePages.endOffset,
            currentPage: messagePages.currentPage,
            totalPages: messagePages.totalPages,
            endedInCodeBlock: messagePages.endedInCodeBlock,
            codeBlockType: messagePages.codeBlockType,
            langchainMessages: fp.langchainMessages,
        })
        .from(messagePages)
        .innerJoin(bot, eq(bot.id, messagePages.messageId))
        .innerJoin(fp, eq(fp.id, messagePages.firstPageMessageId))
        .where(
            and(
                eq(bot.guildId, sql.placeholder("guildId")),
                eq(bot.channelId, sql.placeholder("channelId")),
                eq(bot.discordMessageId, sql.placeholder("discordMessageId")),
            ),
        )
        .limit(1)
        .prepare("get_next_page_data");
}

/** Infrastructure implementation of {@link IGetNextPageQuery}. */
export class PgGetNextPageQuery implements IGetNextPageQuery {
    private readonly stmt: ReturnType<typeof buildGetNextPageStmt>;

    constructor(db: Db) {
        this.stmt = buildGetNextPageStmt(db);
    }

    async execute(lookup: {
        discordMessageId: string;
        channelId: string;
        guildId: string;
    }): Promise<NextPageData | null> {
        return Sentry.startSpan(
            {
                name: "Get next page data",
                op: "db.query",
                attributes: {
                    "db.tables": "message_pages, messages",
                    "discord.message_id": lookup.discordMessageId,
                    "discord.channel_id": lookup.channelId,
                    "discord.guild_id": lookup.guildId,
                },
            },
            async () => {
                try {
                    const [row] = await this.stmt.execute({
                        guildId: lookup.guildId,
                        channelId: lookup.channelId,
                        discordMessageId: lookup.discordMessageId,
                    });

                    if (!row) return null;

                    return {
                        pageStateId: row.pageStateId,
                        firstPageMessageId: row.firstPageMessageId,
                        endOffset: row.endOffset,
                        currentPage: row.currentPage,
                        totalPages: row.totalPages,
                        endedInCodeBlock: row.endedInCodeBlock,
                        codeBlockType: row.codeBlockType ?? null,
                        // TYPE COERCION: Bun SQL driver returns JSON columns as either a pre-parsed
                        // JS value or a raw JSON string; the stored shape matches langchainMessages
                        // by construction (written via BaseMessage.toJSON()), but TS cannot verify it.
                        langchainMessages: (typeof row.langchainMessages === "string"
                            ? JSON.parse(row.langchainMessages)
                            : row.langchainMessages) as DiscordMessage["langchainMessages"],
                    };
                } catch (err) {
                    throw new DatabaseError("Failed to fetch next page data", err);
                }
            },
        );
    }
}
