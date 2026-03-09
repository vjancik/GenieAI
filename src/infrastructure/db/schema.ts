import {
    boolean,
    index,
    json,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";
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

/**
 * Tracks Google API keys used to interact with the Gemini API.
 *
 * Each key is assigned a stable UUID so that Gemini file upload records can
 * reference it as a foreign key. Files are project-scoped in Gemini — URLs
 * uploaded with one key are inaccessible from another. Keys are synced from
 * environment variables at startup via GeminiApiKeySyncService.
 */
export const geminiApiKeys = pgTable("gemini_api_keys", {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The raw Google API key string */
    apiKey: text("api_key").notNull().unique(),
    /** Whether this is a paid key (true) or free-tier key (false). No default — always set explicitly. */
    isPaid: boolean("is_paid").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Permanent anchor table for files uploaded to the Gemini Files API.
 *
 * Each row corresponds to one Discord attachment that has been uploaded at least
 * once. This table is NEVER cleaned — it holds the immutable Discord context
 * (discordAttachmentId, discordFilename, messageDiscordId) needed to re-download
 * the file if it must be refreshed for a different API key.
 *
 * The `original_gemini_url` is the URI returned at the very first upload and is
 * stored in LangChain content blocks as the stable lookup key. It never changes.
 */
export const geminiFiles = pgTable("gemini_files", {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The Gemini URI returned at first upload. Immutable — stored in LangChain
     * content blocks and used as the stable lookup key. Never updated after insert.
     */
    originalGeminiUrl: text("original_gemini_url").notNull().unique(),
    /** Discord attachment snowflake — stable identifier for re-downloading. */
    discordAttachmentId: text("discord_attachment_id").notNull(),
    /** Original filename as uploaded in Discord. Used as displayName on re-upload. */
    discordFilename: text("discord_filename").notNull(),
    /**
     * Discord message that originally created this upload.
     * References messages(discord_message_id); ON DELETE CASCADE removes file records
     * when the originating message is deleted.
     */
    messageDiscordId: text("message_discord_id")
        .notNull()
        .references(() => messages.discordMessageId, { onDelete: "cascade" }),
});

/**
 * Ephemeral per-key upload tracking table.
 *
 * Each row tracks the current Gemini file upload for a specific (file, api_key) pair.
 * Gemini files expire after 48 hours and are project-scoped — a file uploaded with
 * key A is inaccessible from key B. This table maps each GeminiFile to its latest
 * upload per API key so the refresh service can find, validate, and re-upload as needed.
 *
 * Stale rows (uploaded_at > 48h ago) are cleaned by a BEFORE INSERT trigger
 * (migration 0003_stale_cleanup_trigger.sql). The trigger fires once per INSERT
 * statement, not per row, for efficiency.
 *
 * gemini_file_name uses UUID-based names ("files/<uuid>"), guaranteeing global
 * uniqueness across keys and preventing conflicts when rows are re-inserted after cleanup.
 */
export const geminiFileUploads = pgTable(
    "gemini_file_uploads",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        /**
         * FK → gemini_files.id. ON DELETE CASCADE: removing the permanent anchor
         * removes all per-key upload records for that file.
         */
        geminiFileId: uuid("gemini_file_id")
            .notNull()
            .references(() => geminiFiles.id, { onDelete: "cascade" }),
        /**
         * FK → gemini_api_keys.id. ON DELETE CASCADE: removing an API key removes
         * all upload records that were created with it.
         */
        apiKeyId: uuid("api_key_id")
            .notNull()
            .references(() => geminiApiKeys.id, { onDelete: "cascade" }),
        /**
         * The Gemini file name (e.g. "files/<uuid>"). UUID-based — globally unique
         * across projects and keys. Used to call ai.files.delete() before re-uploading.
         */
        geminiFileName: text("gemini_file_name").notNull().unique(),
        /** Current Gemini download URI. Replaced on re-upload. */
        geminiUrl: text("gemini_url").notNull(),
        /** When the current Gemini file was uploaded. Used by the trigger and staleness checks. */
        uploadedAt: timestamp("uploaded_at").notNull(),
    },
    (table) => [
        /** One upload record per (file, api_key) pair — supports upsert on conflict. */
        uniqueIndex("gemini_file_uploads_file_key_idx").on(
            table.geminiFileId,
            table.apiKeyId,
        ),
        /** Index used by the BEFORE INSERT trigger to efficiently delete stale rows. */
        index("gemini_file_uploads_uploaded_at_idx").on(table.uploadedAt),
    ],
);
