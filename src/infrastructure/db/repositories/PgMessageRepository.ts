import { sql } from "drizzle-orm";
import { DatabaseError } from "../../../domain/errors/AppError.ts";
import type { IMessageRepository } from "../../../domain/message/IMessageRepository.ts";
import type { DiscordMessage } from "../../../domain/message/Message.ts";
import type { Logger } from "../../logging/logger.ts";
import type { Db } from "../connection.ts";
import { messages } from "../schema.ts";

/**
 * PostgreSQL implementation of IMessageRepository using Drizzle ORM.
 *
 * Message history is reconstructed on demand using a recursive CTE that
 * walks the repliesToDiscordId chain back to the chain root (null),
 * then orders results chronologically.
 */
export class PgMessageRepository implements IMessageRepository {
    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {}

    async save(
        msg: Omit<DiscordMessage, "id" | "createdAt">,
    ): Promise<DiscordMessage> {
        try {
            const [result] = await this.db
                .insert(messages)
                .values({
                    discordMessageId: msg.discordMessageId,
                    repliesToDiscordId: msg.repliesToDiscordId,
                    channelId: msg.channelId,
                    guildId: msg.guildId,
                    role: msg.role,
                    langchainMessages: msg.langchainMessages,
                })
                .returning();

            if (!result) {
                throw new DatabaseError("Insert returned no result");
            }

            this.logger.debug(
                { discordMessageId: msg.discordMessageId, role: msg.role },
                "Saved message to database",
            );

            return result as DiscordMessage;
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError("Failed to save message", err);
        }
    }

    async fetchChain(startDiscordMessageId: string): Promise<DiscordMessage[]> {
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

            this.logger.debug(
                { startDiscordMessageId, chainLength: rows.length },
                "Fetched message chain",
            );

            return rows.map((row) => ({
                id: row.id as string,
                discordMessageId: row.discord_message_id as string,
                repliesToDiscordId:
                    (row.replies_to_discord_id as string | null) ?? null,
                channelId: row.channel_id as string,
                guildId: (row.guild_id as string | null) ?? null,
                role: row.role as DiscordMessage["role"],
                // langchain_messages is a JSON column; handle both string (raw) and pre-parsed cases
                langchainMessages: (typeof row.langchain_messages === "string"
                    ? JSON.parse(row.langchain_messages)
                    : row.langchain_messages) as DiscordMessage["langchainMessages"],
                createdAt: row.created_at as Date,
            }));
        } catch (err) {
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError("Failed to fetch message chain", err);
        }
    }
}
