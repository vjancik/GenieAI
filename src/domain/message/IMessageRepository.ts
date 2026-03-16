import type { BaseMessage } from "@langchain/core/messages";
import type { DiscordMessage } from "./Message.ts";

/**
 * Port (interface) for Discord message persistence.
 * Implementations are responsible for saving messages and reconstructing
 * full reply chains via recursive traversal.
 */
export interface IMessageRepository {
    /**
     * Persist a single message record.
     * @param message - Message data without auto-generated id and createdAt
     * @returns The saved message including generated id and createdAt
     */
    save(message: Omit<DiscordMessage, "id" | "createdAt">): Promise<DiscordMessage>;

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
    fetchChain(lookup: {
        startDiscordMessageId: string;
        channelId: string;
        guildId: string;
        limit?: number;
    }): Promise<DiscordMessage[]>;

    /**
     * Persist the bot's reply after it has been sent to Discord.
     * Must be called after sending so the Discord-assigned message ID is available.
     *
     * @param params.discordMessageId - The Discord ID of the sent bot reply
     * @param params.repliesToDiscordId - The Discord ID of the user message this replies to
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake, or `"@me"` for DMs
     * @param params.newMessages - All LangChain messages generated during this turn
     * @param params.retriesLeft - Remaining retries to store on the row; only set for retryable responses
     */
    saveAssistantMessage(params: {
        discordMessageId: string;
        repliesToDiscordId: string;
        channelId: string;
        guildId: string;
        newMessages: BaseMessage[];
        retriesLeft?: number | null;
    }): Promise<DiscordMessage>;

    /**
     * Fetch a single message by its UUID primary key.
     *
     * @param id - The UUIDv7 primary key
     * @returns The message, or null if not found
     */
    findById(id: string): Promise<DiscordMessage | null>;

    /**
     * Fetch a single message by the (guildId, channelId, discordMessageId) triple that
     * uniquely identifies it. For DMs where no guild exists, pass `"@me"` as `guildId`.
     *
     * @param lookup.discordMessageId - The Discord snowflake ID of the message
     * @param lookup.channelId - The Discord channel snowflake
     * @param lookup.guildId - The Discord guild snowflake, or `"@me"` for DMs
     * @returns The message, or null if not found
     */
    findByDiscordMessageId(lookup: {
        discordMessageId: string;
        channelId: string;
        guildId: string;
    }): Promise<DiscordMessage | null>;

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
    findExistingDiscordIds(lookup: {
        guildId: string;
        channelId: string;
        discordMessageIds: string[];
    }): Promise<string[]>;

    /**
     * Batch-insert multiple message records, skipping any that already exist
     * (by the unique guild+channel+discordMessageId constraint).
     *
     * Used when persisting a live-fetched Discord reply chain so that pre-existing
     * messages are silently skipped without causing constraint errors.
     *
     * @param messages - Array of message data without auto-generated id and createdAt
     * @returns All successfully inserted rows (excludes silently skipped duplicates)
     */
    saveBatch(messages: Omit<DiscordMessage, "id" | "createdAt">[]): Promise<DiscordMessage[]>;
}
