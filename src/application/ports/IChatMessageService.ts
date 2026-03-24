import type { IChatClientMessage } from "./chat/IChatClientMessage.ts";

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
    }): Promise<IChatClientMessage[]>;
}
