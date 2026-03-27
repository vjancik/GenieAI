import type { BaseMessage } from "@langchain/core/messages";
import type { PersistedChatMessage } from "../entities/Message.ts";

/**
 * Input shape for persisting a message row.
 * Uses `BaseMessage[]` for `langchainMessages` — serialization to `Record<string, unknown>[]`
 * is handled by the repository implementation, not the caller.
 */
export type SaveMessageParams = Omit<PersistedChatMessage, "id" | "createdAt" | "langchainMessages"> & {
    langchainMessages: BaseMessage[];
};

export type DiscordIds = Pick<PersistedChatMessage, "discordMessageId" | "channelId" | "guildId">;

// TODO: consider using Prettify type helper for cleaner caller parameter signatures

/**
 * Port (interface) for Discord message persistence.
 * Implementations are responsible for saving messages and reconstructing
 * full reply chains via recursive traversal.
 */
export interface IMessageRepository {
    /**
     * Persist a single message record.
     * @param message - Message data; `langchainMessages` accepts `BaseMessage[]` — serialization is handled by the implementation
     * @returns The DB-assigned UUID of the inserted row
     */
    save(message: SaveMessageParams): Promise<Pick<PersistedChatMessage, "id">>;

    /**
     * Fetch the reply chain for the given message, identified by the
     * (guildId, channelId, discordMessageId) triple.
     * Uses a recursive CTE to walk up the repliesToDiscordId links until the
     * root (null), then returns all messages in chronological order.
     *
     * @param lookup.startDiscordMessageId - The Discord message ID to start the chain from
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     * @param lookup.limit - Maximum number of rows to return (default: 10000, guards against infinite loops)
     * @returns Messages ordered chronologically (oldest first), or [] if not found
     */
    fetchChain(
        lookup: {
            startDiscordMessageId: string;
            limit?: number;
        } & Omit<DiscordIds, "discordMessageId">,
    ): Promise<PersistedChatMessage[]>;

    /**
     * Persist the bot's reply after it has been sent to Discord.
     * Must be called after sending so the Discord-assigned message ID is available.
     *
     * @param params.discordMessageId - The Discord ID of the sent bot reply
     * @param params.repliesToDiscordId - The Discord ID of the user message this replies to
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake, or `"@me"` for DMs
     * @param params.langchainMessages - All LangChain messages generated during this turn
     * @param params.retriesLeft - Remaining retries to store on the row; only set for retryable responses
     * @returns The DB-assigned UUID of the inserted row
     */
    saveBotMessage(params: Omit<SaveMessageParams, "role">): Promise<Pick<PersistedChatMessage, "id">>;

    /**
     * Saves a non-content bot reply (error notice, shutdown/rate-limit message, sources
     * follow-up) with empty LangChain messages and no retry/fallback metadata.
     *
     * @param params.discordMessageId - The Discord ID of the sent bot reply
     * @param params.repliesToDiscordId - The Discord ID of the message this replies to
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake, or `"@me"` for DMs
     * @param params.discordAuthorId - Discord user ID of the bot
     * @returns The DB-assigned UUID of the inserted row
     */
    saveBotPlaceholderMessage(
        params: Pick<
            SaveMessageParams,
            "discordMessageId" | "repliesToDiscordId" | "channelId" | "guildId" | "discordAuthorId"
        >,
    ): Promise<Pick<PersistedChatMessage, "id">>;

    /**
     * Fetch a single message by its UUID primary key.
     *
     * @param id - The UUIDv7 primary key
     * @returns The message, or null if not found
     */
    findById(id: PersistedChatMessage["id"]): Promise<PersistedChatMessage | null>;

    /**
     * Fetch a single message by the (guildId, channelId, discordMessageId) triple that
     * uniquely identifies it. For DMs where no guild exists, pass `"@me"` as `guildId`.
     *
     * @param lookup.discordMessageId - The Discord snowflake ID of the message
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     * @returns The message, or null if not found
     */
    findByDiscordMessageId(lookup: DiscordIds): Promise<PersistedChatMessage | null>;

    /**
     * Returns the subset of the given Discord message IDs that are already
     * persisted for the given guild and channel.
     *
     * Used before a batch save to avoid re-inserting messages that already exist
     * (which would violate the unique guild+channel+discordMessageId constraint).
     *
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.discordMessageIds - The Discord snowflake IDs to check
     * @returns The subset of discordMessageIds that exist in the DB
     */
    findExistingDiscordIds(
        lookup: {
            discordMessageIds: string[];
        } & Omit<DiscordIds, "discordMessageId">,
    ): Promise<PersistedChatMessage["discordMessageId"][]>;

    /**
     * Returns true if a message row exists for the given (guildId, channelId, discordMessageId) triple.
     *
     * Cheaper than {@link findByDiscordMessageId} — fetches only the id column.
     *
     * @param lookup.discordMessageId - The Discord snowflake ID of the message
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     */
    existsByDiscordMessageId(lookup: DiscordIds): Promise<boolean>;

    /**
     * Returns the UUID primary key of a message row by its Discord snowflake triple,
     * or `null` if not found. Fetches only the `id` column.
     *
     * @param lookup.discordMessageId - The Discord snowflake ID of the message
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     */
    getIdByDiscordMessageId(lookup: DiscordIds): Promise<PersistedChatMessage["id"] | null>;

    /**
     * Delete a single message row by its Discord message ID, guild, and channel.
     * Cascades to message_pages and gemini_files rows via DB foreign keys.
     * No-ops silently if the row does not exist.
     *
     * @param lookup.discordMessageId - The Discord snowflake ID of the message to delete
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     */
    deleteByDiscordMessageId(lookup: DiscordIds): Promise<void>;

    /**
     * Batch-insert multiple message records, skipping any that already exist
     * (by the unique guild+channel+discordMessageId constraint).
     *
     * Uses `ON CONFLICT DO UPDATE SET id = id` (no-op) so that `.returning()` always
     * yields exactly N rows in insertion order — one per input, including pre-existing
     * rows. Callers can safely correlate returned UUIDs to inputs by index.
     *
     * @param messages - Array of message data without auto-generated id and createdAt
     * @returns Always N `{ id }` objects, index-aligned with the input array
     */
    saveBatch(messages: SaveMessageParams[]): Promise<Pick<PersistedChatMessage, "id">[]>;
}
