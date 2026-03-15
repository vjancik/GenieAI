import * as Sentry from "@sentry/bun";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "../../../application/types/Logger.ts";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { IMessageRepository } from "../../../domain/message/IMessageRepository.ts";
import type { DiscordMessage } from "../../../domain/message/Message.ts";
import type { Db } from "../connection.ts";
import { messages } from "../schema.ts";

/** Prepared statement: fetch a single message by its UUID primary key. */
function buildFindByIdStmt(db: Db) {
    return db
        .select()
        .from(messages)
        .where(eq(messages.id, sql.placeholder("id")))
        .limit(1)
        .prepare("message_find_by_id");
}

/**
 * Prepared statement: fetch a single message by the (guildId, channelId, discordMessageId) triple.
 * Only usable for guild messages where guildId IS NOT NULL. DM lookups (guildId IS NULL)
 * require a separate dynamic query since prepared statements cannot switch between = ? and IS NULL.
 */
function buildFindByDiscordMessageIdGuildStmt(db: Db) {
    return db
        .select()
        .from(messages)
        .where(
            and(
                eq(messages.guildId, sql.placeholder("guildId")),
                eq(messages.channelId, sql.placeholder("channelId")),
                eq(messages.discordMessageId, sql.placeholder("discordMessageId")),
            ),
        )
        .limit(1)
        .prepare("message_find_by_discord_id_guild");
}

/** Prepared statement: insert a new message row and return it. */
function buildInsertMessageStmt(db: Db) {
    return db
        .insert(messages)
        .values({
            discordMessageId: sql.placeholder("discordMessageId"),
            repliesToDiscordId: sql.placeholder("repliesToDiscordId"),
            channelId: sql.placeholder("channelId"),
            guildId: sql.placeholder("guildId"),
            role: sql.placeholder("role"),
            langchainMessages: sql.placeholder("langchainMessages"),
        })
        .returning()
        .prepare("message_insert");
}

/**
 * PostgreSQL implementation of IMessageRepository using Drizzle ORM.
 *
 * Message history is reconstructed on demand using a recursive CTE that
 * walks the repliesToDiscordId chain back to the chain root (null),
 * then orders results chronologically.
 *
 * Prepared statements are cached on construction for queries with stable structure,
 * reducing per-call planning overhead.
 */
export class PgMessageRepository implements IMessageRepository {
    private readonly stmtInsertMessage: ReturnType<typeof buildInsertMessageStmt>;
    private readonly stmtFindById: ReturnType<typeof buildFindByIdStmt>;
    private readonly stmtFindByDiscordMessageIdGuild: ReturnType<typeof buildFindByDiscordMessageIdGuildStmt>;

    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {
        this.stmtInsertMessage = buildInsertMessageStmt(db);
        this.stmtFindById = buildFindByIdStmt(db);
        this.stmtFindByDiscordMessageIdGuild = buildFindByDiscordMessageIdGuildStmt(db);
    }

    async save(msg: Omit<DiscordMessage, "id" | "createdAt">): Promise<DiscordMessage> {
        return Sentry.startSpan(
            {
                name: "Save message to database",
                op: "db.query",
                attributes: {
                    "db.table": "messages",
                    "discord.message_id": msg.discordMessageId,
                    "discord.role": msg.role,
                },
            },
            async () => {
                try {
                    const [result] = await this.stmtInsertMessage.execute({
                        discordMessageId: msg.discordMessageId,
                        repliesToDiscordId: msg.repliesToDiscordId,
                        channelId: msg.channelId,
                        guildId: msg.guildId,
                        role: msg.role,
                        langchainMessages: msg.langchainMessages,
                    });

                    if (!result) {
                        throw new DatabaseError("Insert returned no result");
                    }

                    this.logger.debug(
                        {
                            discordMessageId: msg.discordMessageId,
                            role: msg.role,
                        },
                        "Saved message to database",
                    );

                    return result;
                } catch (err) {
                    if (err instanceof DatabaseError) throw err;
                    throw new DatabaseError("Failed to save message", err);
                }
            },
        );
    }

    async findById(id: string): Promise<DiscordMessage | null> {
        return Sentry.startSpan(
            {
                name: "Find message by ID",
                op: "db.query",
                attributes: { "db.table": "messages", "db.message_id": id },
            },
            async () => {
                try {
                    const [result] = await this.stmtFindById.execute({ id });
                    if (!result) return null;
                    return {
                        id: result.id,
                        discordMessageId: result.discordMessageId,
                        repliesToDiscordId: result.repliesToDiscordId ?? null,
                        channelId: result.channelId,
                        guildId: result.guildId,
                        role: result.role,
                        // TYPE COERCION: the parsed value's shape matches DiscordMessage["langchainMessages"]
                        // by construction (it was stored from BaseMessage.toJSON()), but TS cannot verify it.
                        langchainMessages: (typeof result.langchainMessages === "string"
                            ? JSON.parse(result.langchainMessages)
                            : result.langchainMessages) as DiscordMessage["langchainMessages"],
                        createdAt: result.createdAt,
                    };
                } catch (err) {
                    throw new DatabaseError("Failed to find message by ID", err);
                }
            },
        );
    }

    async findByDiscordMessageId(lookup: {
        discordMessageId: string;
        channelId: string;
        guildId: string;
    }): Promise<DiscordMessage | null> {
        return Sentry.startSpan(
            {
                name: "Find message by Discord ID",
                op: "db.query",
                attributes: {
                    "db.table": "messages",
                    "discord.message_id": lookup.discordMessageId,
                    "discord.channel_id": lookup.channelId,
                    "discord.guild_id": lookup.guildId,
                },
            },
            async () => {
                try {
                    const [result] = await this.stmtFindByDiscordMessageIdGuild.execute({
                        guildId: lookup.guildId,
                        channelId: lookup.channelId,
                        discordMessageId: lookup.discordMessageId,
                    });

                    if (!result) return null;

                    this.logger.debug(lookup, "Found message by Discord ID");

                    return {
                        id: result.id,
                        discordMessageId: result.discordMessageId,
                        repliesToDiscordId: result.repliesToDiscordId ?? null,
                        channelId: result.channelId,
                        guildId: result.guildId,
                        role: result.role,
                        // langchain_messages is a JSON column; Bun's SQL driver may return it as either a
                        // pre-parsed JS value or a raw JSON string — handle both cases defensively.
                        // TYPE COERCION: the parsed value's shape matches DiscordMessage["langchainMessages"]
                        // by construction (it was stored from BaseMessage.toJSON()), but TS cannot verify it.
                        langchainMessages: (typeof result.langchainMessages === "string"
                            ? JSON.parse(result.langchainMessages)
                            : result.langchainMessages) as DiscordMessage["langchainMessages"],
                        createdAt: result.createdAt,
                    };
                } catch (err) {
                    throw new DatabaseError("Failed to find message by Discord ID", err);
                }
            },
        );
    }

    async fetchChain(startDiscordMessageId: string): Promise<DiscordMessage[]> {
        return Sentry.startSpan(
            {
                name: "Fetch message chain",
                op: "db.query",
                attributes: {
                    "db.table": "messages",
                    "discord.message_id": startDiscordMessageId,
                },
            },
            async (span) => {
                /**
                 * Recursive CTE that walks UP the reply chain from the given Discord message ID.
                 *
                 * Base case: the message with discord_message_id = startDiscordMessageId.
                 * Recursive case: for each row in message_chain, find the message whose
                 *   discord_message_id equals the current row's replies_to_discord_id.
                 *   This traverses upward until replies_to_discord_id IS NULL (chain root).
                 *
                 * The collected rows are then ordered by created_at ASC to produce
                 * chronological conversation history.
                 *
                 * langchain_messages is a JSON column; Bun's SQL driver may return it as either
                 * a pre-parsed JS value or as a raw JSON string depending on the query path.
                 * The row mapping below handles both cases defensively.
                 *
                 * Note: recursive CTEs cannot be expressed via the Drizzle query builder and
                 * therefore cannot use a prepared statement — raw SQL is required here.
                 */
                try {
                    const rows = await this.db.execute(sql`
                        WITH RECURSIVE message_chain AS (
                            SELECT * FROM messages
                            WHERE discord_message_id = ${startDiscordMessageId}
                            UNION ALL
                            SELECT m.* FROM messages m
                            INNER JOIN message_chain mc ON m.discord_message_id = mc.replies_to_discord_id
                        )
                        SELECT * FROM message_chain ORDER BY created_at ASC
                    `);

                    span.setAttribute("db.result_count", rows.length);

                    this.logger.debug({ startDiscordMessageId, chainLength: rows.length }, "Fetched message chain");

                    // TYPE COERCION: Drizzle's db.execute() returns Record<string, unknown>[] for raw SQL —
                    // column types cannot be inferred statically, so each field is asserted from the known schema.
                    return rows.map((row) => ({
                        id: row.id as string,
                        discordMessageId: row.discord_message_id as string,
                        repliesToDiscordId: (row.replies_to_discord_id as string | null) ?? null,
                        channelId: row.channel_id as string,
                        guildId: row.guild_id as string,
                        role: row.role as DiscordMessage["role"],
                        // langchain_messages is a JSON column; Bun's SQL driver may return it as either a
                        // pre-parsed JS value or a raw JSON string — handle both cases defensively.
                        // TYPE COERCION: the parsed value's shape matches DiscordMessage["langchainMessages"]
                        // by construction (it was stored from BaseMessage.toJSON()), but TS cannot verify it.
                        langchainMessages: (typeof row.langchain_messages === "string"
                            ? JSON.parse(row.langchain_messages)
                            : row.langchain_messages) as DiscordMessage["langchainMessages"],
                        createdAt: row.created_at as Date,
                    }));
                } catch (err) {
                    if (err instanceof DatabaseError) throw err;
                    throw new DatabaseError("Failed to fetch message chain", err);
                }
            },
        );
    }
}
