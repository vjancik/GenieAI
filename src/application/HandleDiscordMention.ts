import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { IMessageRepository } from "../domain/message/IMessageRepository.ts";
import { getBlockType } from "../infrastructure/attachments/contentBlockMapper.ts";
import type { AppConfig } from "../infrastructure/config/config.ts";
import type { Orchestrator } from "../infrastructure/llm/orchestrator.ts";
import { dbMessagesToLangchain } from "../infrastructure/llm/orchestrator.ts";
import type { Logger } from "../infrastructure/logging/logger.ts";
import type {
    DiscordAttachmentInfo,
    IAttachmentDownloader,
} from "./ports/IAttachmentDownloader.ts";
import type { OnStatusUpdate } from "./types/AgentStatus.ts";
import { AgentStatusType } from "./types/AgentStatus.ts";

/**
 * Application use case: handle an incoming Discord @mention.
 *
 * Coordinates:
 * 1. Fetching prior conversation history from the reply chain
 * 2. Downloading any file attachments (inline mode) and building a multimodal HumanMessage
 * 3. Invoking the LLM orchestrator with history + current message
 * 4. Persisting the user's message to the database
 *
 * The bot's response message is persisted separately (via {@link saveBotResponse})
 * after it has been sent to Discord, because we need Discord's message ID.
 *
 * All messages are serialized using LangChain's BaseMessage.toJSON() to preserve
 * full metadata (thoughtSignatures, tool calls, response_metadata) for context continuity.
 */
export class HandleDiscordMention {
    private readonly maxInlineBytes: number;

    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly orchestrator: Orchestrator,
        private readonly attachmentDownloader: IAttachmentDownloader,
        private readonly logger: Logger,
        config: Pick<AppConfig, "maxInlineAttachmentSizeMb">,
    ) {
        this.maxInlineBytes = config.maxInlineAttachmentSizeMb * 1024 * 1024;
    }

    /**
     * Process an incoming Discord mention event.
     *
     * @param params.discordMessageId - Discord snowflake for the user's message
     * @param params.referencedMessageId - Discord snowflake of the message being replied to, or null
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake (null for DMs)
     * @param params.userContent - Message content with bot mention stripped
     * @param params.attachments - File attachments on the Discord message
     * @param params.onStatusUpdate - Optional callback forwarded to the orchestrator for live status updates
     * @returns The AI-generated response string and the new LangChain messages generated,
     *          or an error string if attachments exceed the size limit
     */
    async handle(params: {
        discordMessageId: string;
        referencedMessageId: string | null;
        channelId: string;
        guildId: string | null;
        userContent: string;
        attachments: DiscordAttachmentInfo[];
        onStatusUpdate?: OnStatusUpdate;
    }): Promise<{ response: string; newMessages: BaseMessage[] }> {
        // Guard: reject if total attachment size exceeds the configured limit
        if (params.attachments.length > 0) {
            const totalBytes = params.attachments.reduce(
                (sum, a) => sum + a.size,
                0,
            );
            if (totalBytes > this.maxInlineBytes) {
                const limitMb = this.maxInlineBytes / (1024 * 1024);
                const actualMb = (totalBytes / (1024 * 1024)).toFixed(1);
                this.logger.warn(
                    {
                        totalBytes,
                        maxBytes: this.maxInlineBytes,
                        discordMessageId: params.discordMessageId,
                    },
                    "Attachment size exceeds limit — rejecting",
                );
                return {
                    response: `Sorry, your attachments total ${actualMb} MB which exceeds the ${limitMb} MB limit. Please send smaller files.`,
                    newMessages: [],
                };
            }
        }

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
                attachmentCount: params.attachments.length,
            },
            "Processing mention with history",
        );

        // TODO: this could use some logging, especially so we can see the type + mimeType combinations. You can truncate the actual message text to first 100 characters and also omit the data in the log
        // Build the human message — multimodal if attachments are present
        const humanMsg = await this.buildHumanMessage(
            params.userContent,
            params.attachments,
            params.onStatusUpdate,
        );

        // Generate the AI response; collect all new messages for persistence
        const { content, newMessages } = await this.orchestrator.process(
            history,
            humanMsg,
            params.onStatusUpdate,
        );

        // Persist the user's message (may contain multimodal content blocks)
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

    /**
     * Constructs a HumanMessage from user text and optional file attachments.
     *
     * If there are no attachments, returns a simple string-content HumanMessage.
     * Otherwise emits a DOWNLOADING_ATTACHMENTS status update, downloads all
     * attachments in parallel, and returns a multimodal HumanMessage with
     * a text block followed by one content block per attachment.
     *
     * The text block is always first; attachment blocks follow in Discord message order.
     */
    private async buildHumanMessage(
        userContent: string,
        attachments: DiscordAttachmentInfo[],
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<HumanMessage> {
        if (attachments.length === 0) {
            return new HumanMessage(userContent);
        }

        onStatusUpdate?.({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS });

        const downloaded = await Promise.all(
            attachments.map((a) => this.attachmentDownloader.download(a)),
        );

        this.logger.debug(
            { count: downloaded.length, names: downloaded.map((d) => d.name) },
            "Downloaded attachments for inline embedding",
        );

        const blocks = [
            // Text block first — only included when the user typed something
            ...(userContent
                ? [{ type: "text" as const, text: userContent }]
                : []),
            // One block per attachment; block type is inferred from the MIME type
            ...downloaded.map((d) => ({
                type: getBlockType(d.mimeType),
                mimeType: d.mimeType,
                data: d.data,
            })),
        ];

        return new HumanMessage({ content: blocks });
    }
}
