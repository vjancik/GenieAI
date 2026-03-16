import type { DiscordAttachmentInfo } from "./IAttachmentDownloader.ts";

/**
 * A type-safe subset of a Discord message, containing only the fields needed
 * by the application layer. Prevents discord.js types from leaking into use cases.
 */
export interface DiscordMessageSnapshot {
    /** Discord snowflake ID of the message. */
    id: string;
    /** Raw message text content. */
    content: string;
    /** Discord user ID of the author. */
    authorId: string;
    /** Author's username (not display name). */
    authorUsername: string;
    /** Author's resolved display name: server nickname > global display name > username. */
    authorDisplayName: string;
    /** Whether the author is any bot user. */
    isBot: boolean;
    /**
     * Whether the author is this bot or a recognized previous bot version.
     * When true, the message is treated as role "assistant" when reconstructing history.
     * Includes messages from the optional PREVIOUS_BOT_ID config value to support
     * migrations from earlier bot applications.
     */
    isOwnBot: boolean;
    /** File attachments on the message. */
    attachments: DiscordAttachmentInfo[];
    /** Discord snowflake ID of the message this is replying to, or null for chain roots. */
    referencedMessageId: string | null;
    /** Discord channel snowflake. */
    channelId: string;
    /** Discord guild snowflake, or `"@me"` for DMs. */
    guildId: string;
    /** When the message was created. */
    createdAt: Date;
}

/**
 * Port for fetching live Discord message chains.
 *
 * Used as a fallback when the DB reply chain is empty — e.g. when the user
 * replies to a message that was never persisted by the bot (pre-existing
 * conversations, DB wipes, third-party messages joining the chain).
 */
export interface IChatMessageService {
    /**
     * Walks the Discord reply chain starting from `startDiscordMessageId`,
     * fetching each parent message from the Discord API until the chain root
     * (no reference) or the limit is reached.
     *
     * Returns messages in chronological order (oldest first).
     * Returns an empty array if the start message cannot be found.
     * On mid-chain fetch failures, returns the partial chain collected so far.
     *
     * @param lookup.startDiscordMessageId - Discord snowflake of the message to start from
     * @param lookup.channelId - Discord channel snowflake
     * @param lookup.guildId - Discord guild snowflake, or `"@me"` for DMs
     * @param lookup.limit - Maximum number of messages to fetch (default: 50)
     */
    fetchChain(lookup: {
        startDiscordMessageId: string;
        channelId: string;
        guildId: string;
        limit?: number;
    }): Promise<DiscordMessageSnapshot[]>;
}
