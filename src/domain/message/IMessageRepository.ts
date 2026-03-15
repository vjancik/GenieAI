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
}
