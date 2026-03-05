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
    guildId: string | null;
    role: MessageRole;
    /**
     * Serialized LangChain BaseMessage objects (output of BaseMessage.toJSON()).
     * Deserialized via load() from @langchain/core/load.
     */
    langchainMessages: Record<string, unknown>[];
    createdAt: Date;
}
