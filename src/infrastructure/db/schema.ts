import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ContentChunk } from "../../domain/message/Message.ts";

/**
 * Drizzle ORM schema for the messages table.
 *
 * Each row represents one Discord message in a reply chain.
 * Only the message's own content is stored — the full conversation context is
 * reconstructed on read via a recursive CTE traversing repliesToDiscordId.
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
    /** LangChain-compatible content chunks (text, image_url, etc.) stored as JSONB */
    contentChunks: jsonb("content_chunks").notNull().$type<ContentChunk[]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
