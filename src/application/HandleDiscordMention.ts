import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { IMessageRepository } from "../domain/message/IMessageRepository.ts";
import type { Orchestrator } from "../infrastructure/llm/orchestrator.ts";
import { dbMessagesToLangchain } from "../infrastructure/llm/orchestrator.ts";
import type { Logger } from "../infrastructure/logging/logger.ts";
import type { OnStatusUpdate } from "./types/AgentStatus.ts";

/**
 * Application use case: handle an incoming Discord @mention.
 *
 * Coordinates:
 * 1. Fetching prior conversation history from the reply chain
 * 2. Invoking the LLM orchestrator with history + current message
 * 3. Persisting the user's message to the database
 *
 * The bot's response message is persisted separately (via {@link saveBotResponse})
 * after it has been sent to Discord, because we need Discord's message ID.
 *
 * All messages are serialized using LangChain's BaseMessage.toJSON() to preserve
 * full metadata (thoughtSignatures, tool calls, response_metadata) for context continuity.
 */
export class HandleDiscordMention {
    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly orchestrator: Orchestrator,
        private readonly logger: Logger,
    ) {}

    /**
     * Process an incoming Discord mention event.
     *
     * @param params.discordMessageId - Discord snowflake for the user's message
     * @param params.referencedMessageId - Discord snowflake of the message being replied to, or null
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake (null for DMs)
     * @param params.userContent - Message content with bot mention stripped
     * @param params.onStatusUpdate - Optional callback forwarded to the orchestrator for live status updates
     * @returns The AI-generated response string and the new LangChain messages generated
     */
    async handle(params: {
        discordMessageId: string;
        referencedMessageId: string | null;
        channelId: string;
        guildId: string | null;
        userContent: string;
        onStatusUpdate?: OnStatusUpdate;
    }): Promise<{ response: string; newMessages: BaseMessage[] }> {
        // Fetch existing reply chain if this message is a reply
        const history =
            params.referencedMessageId !== null
                ? dbMessagesToLangchain(
                      await this.messageRepo.fetchChain(
                          params.referencedMessageId,
                      ),
                      this.logger,
                  )
                : [];

        this.logger.debug(
            {
                discordMessageId: params.discordMessageId,
                historyLength: history.length,
                hasReply: params.referencedMessageId !== null,
            },
            "Processing mention with history",
        );

        // Generate the AI response; collect all new messages for persistence
        const { content, newMessages } = await this.orchestrator.process(
            history,
            params.userContent,
            params.onStatusUpdate,
        );

        // Persist the user's message as a serialized HumanMessage
        const humanMsg = new HumanMessage(params.userContent);
        await this.messageRepo.save({
            discordMessageId: params.discordMessageId,
            repliesToDiscordId: params.referencedMessageId,
            channelId: params.channelId,
            guildId: params.guildId,
            role: "human",
            langchainMessages: [
                humanMsg.toJSON() as unknown as Record<string, unknown>,
            ],
        });

        return { response: content, newMessages };
    }

    /**
     * Persist the bot's reply message after it has been sent to Discord.
     * Must be called after sending the reply so we can capture Discord's assigned message ID.
     *
     * Stores all LangChain messages generated during processing (triage response, tool messages,
     * final response) so the conversation history has no gaps.
     *
     * @param params.botDiscordMessageId - The Discord ID of the sent bot reply
     * @param params.repliesToDiscordId - The Discord ID of the user message this replies to
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake (null for DMs)
     * @param params.newMessages - All LangChain messages generated during this turn
     */
    async saveBotResponse(params: {
        botDiscordMessageId: string;
        repliesToDiscordId: string;
        channelId: string;
        guildId: string | null;
        newMessages: BaseMessage[];
    }): Promise<void> {
        await this.messageRepo.save({
            discordMessageId: params.botDiscordMessageId,
            repliesToDiscordId: params.repliesToDiscordId,
            channelId: params.channelId,
            guildId: params.guildId,
            role: "assistant",
            langchainMessages: params.newMessages.map(
                (m) => m.toJSON() as unknown as Record<string, unknown>,
            ),
        });

        this.logger.debug(
            {
                botDiscordMessageId: params.botDiscordMessageId,
                messageCount: params.newMessages.length,
            },
            "Saved bot response to database",
        );
    }
}
