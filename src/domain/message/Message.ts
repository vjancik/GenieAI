/**
 * Domain entity types for Discord message persistence.
 * Content is stored as an array of serialized LangChain message objects (via BaseMessage.toJSON())
 * to preserve all metadata including thoughtSignatures, tool calls, and response_metadata.
 */

export type MessageRole = "human" | "assistant";

/**
 * A persisted Discord message within a reply chain.
 *
 * Only the message's own content is stored (not the full conversation),
 * allowing the recursive CTE to reconstruct the chain on demand.
 *
 * Each record can hold multiple serialized LangChain messages — e.g. for a bot
 * turn that involved tool use, this array would contain:
 * [triageAIMessage, ToolMessage, finalAIMessage].
 */
export interface DiscordMessage {
    /** UUID primary key */
    id: string;
    /** Discord's snowflake ID for this message */
    discordMessageId: string;
    /** Discord snowflake of the message this replies to, or null if chain root */
    repliesToDiscordId: string | null;
    channelId: string;
    /** Discord guild snowflake, or "@me" for DMs */
    guildId: string;
    role: MessageRole;
    /**
     * Serialized LangChain BaseMessage objects (output of BaseMessage.toJSON()).
     * Deserialized by passing through JSON.parse (Bun SQL driver may return pre-parsed objects).
     */
    langchainMessages: Record<string, unknown>[];
    /**
     * Remaining retry attempts for this bot response.
     * Only set on retryable bot responses (fallback model was used).
     * NULL on human messages and non-retryable bot responses.
     */
    retriesLeft: number | null;
    createdAt: Date;
}
