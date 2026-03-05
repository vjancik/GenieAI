import { json, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DiscordMessage } from "../../domain/message/Message.ts";

/**
 * Drizzle ORM schema for the messages table.
 *
 * Each row represents one Discord message in a reply chain.
 * Only the message's own content is stored — the full conversation context is
 * reconstructed on read via a recursive CTE traversing repliesToDiscordId.
 *
 * langchain_messages stores an array of serialized LangChain BaseMessage objects
 * (output of BaseMessage.toJSON()). One row can hold multiple LangChain messages
 * — e.g. a bot turn with tool use stores [triageAIMsg, ToolMsg, finalAIMsg].
 *
 * JSON (not JSONB) is used since we never perform key-level operations on this column.
 */
export const messages = pgTable("messages", {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The Discord snowflake ID for this message */
    discordMessageId: text("discord_message_id").notNull().unique(),
    /** Discord snowflake of the parent message in the reply chain, null for chain root */
    repliesToDiscordId: text("replies_to_discord_id"),
    channelId: text("channel_id").notNull(),
    guildId: text("guild_id"),
    role: text("role", { enum: ["human", "assistant"] }).notNull(),
    /** Serialized LangChain BaseMessage objects stored as JSON array */
    langchainMessages: json("langchain_messages")
        .notNull()
        .$type<DiscordMessage["langchainMessages"]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
