import * as Sentry from "@sentry/bun";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import { MessageIntent } from "../../domain/message/MessageIntent.ts";
import { extractUserContent } from "../helpers/extractUserContent.ts";
import type {
    IChatClientBot,
    IChatClientContextMenuInteraction,
    IChatClientMessage,
} from "../ports/chat/IChatClient.ts";
import type { Logger } from "../types/Logger.ts";
import type { HandleChatMessageUseCase } from "./HandleChatMessage.ts";

/** Sentinel value stored as guild_id for DM messages, which have no guild. */
const DM_GUILD_TOKEN = "@me";

/**
 * Application use case: handles the Summarize message context menu command.
 *
 * Fetches the target message, acknowledges the interaction ephemerally, then
 * invokes the agent with SUMMARY intent. The bot reply is sent as a reply to the
 * target message and prefixed with a mention of the invoker.
 */
export class HandleSummarizeUseCase {
    /**
     * @param handleChatMessage - Use case for the full message handling pipeline
     * @param messageRepo - Repository for checking whether a message already exists in the DB
     * @param bot - Chat client bot adapter for reading the current bot user ID
     * @param logger - Logger instance
     */
    constructor(
        private readonly handleChatMessage: HandleChatMessageUseCase,
        private readonly messageRepo: IMessageRepository,
        private readonly bot: IChatClientBot,
        private readonly logger: Logger,
    ) {}

    /**
     * Executes the Summarize flow for a context menu interaction.
     *
     * Acknowledges the interaction with a visible ephemeral reply (deleted after 5 s),
     * checks whether the target message already exists in the DB to avoid duplicate
     * human message rows, then invokes the agent with SUMMARY intent.
     */
    async execute(interaction: IChatClientContextMenuInteraction): Promise<void> {
        await Sentry.startSpan(
            {
                name: "Handle Summarize command",
                op: "chat.command.summarize",
                attributes: {
                    // NOTE: pass in to use case when extending
                    "chat.platform": "Discord",
                    "chat.command.type": "Context Menu",
                    "chat.message_id": interaction.targetMessage.id,
                },
            },
            async () => {
                const botUserId = this.bot.userId;

                const targetMessage = interaction.targetMessage;

                this.logger.info(
                    {
                        targetMessageId: targetMessage.id,
                        channelId: targetMessage.channelId,
                        guildId: targetMessage.guildId,
                        invokerUserId: interaction.userId,
                    },
                    "Handling Summarize command",
                );
                const attachments = targetMessage.attachments;
                const embeds = targetMessage.embeds;
                const userContent = extractUserContent(targetMessage.content, botUserId, targetMessage.botRoleId);

                // ACK the interaction with a visible ephemeral reply so Discord doesn't show
                // "interaction failed". Deleted after 5 seconds — the thinking placeholder on
                // the target message is the real visual feedback.
                await interaction.reply({ content: "*Generating summary...*", isEphemeral: true });
                setTimeout(() => void interaction.deleteReply().catch(() => {}), 5_000);

                // When the invoker is also the message author, replying to their own message already
                // pings them via Discord's reply mechanism — no explicit mention prefix needed, and
                // allowedMentions.repliedUser suppression would strip it anyway.
                const isSelfReply = interaction.userId === targetMessage.authorId;
                const pingUser = isSelfReply;
                const replyPrefix = isSelfReply ? undefined : `<@${interaction.userId}>`;

                // If this message was already saved (e.g. summarized before), skip re-inserting
                // the human message row — reuse the existing DB record instead.
                const reuseHumanMessage = await this.messageRepo.existsByDiscordMessageId({
                    discordMessageId: targetMessage.id,
                    channelId: targetMessage.channelId,
                    guildId: targetMessage.guildId ?? DM_GUILD_TOKEN,
                });

                void (await this.invokeAgentWithMessage({
                    message: targetMessage,
                    userContent,
                    attachments,
                    embeds,
                    intent: MessageIntent.SUMMARY,
                    pingUser,
                    replyPrefix,
                    interactionType: "summary_command",
                    interactionAuthorDiscordId: interaction.userId,
                    reuseHumanMessage,
                    fetchHistory: false,
                    // TODO: add a language preference to config
                    ephemeralInstructionMessage: "Summarize this in English",
                }));
            },
        );
    }

    /**
     * Core agent invocation: wraps {@link HandleChatMessageUseCase.invokeAgentAndReply}
     * with a Sentry span for observability.
     */
    private async invokeAgentWithMessage(params: {
        message: IChatClientMessage;
        userContent: string | null;
        attachments: IChatClientMessage["attachments"] | null;
        embeds?: IChatClientMessage["embeds"];
        intent: MessageIntent;
        retriesLeft?: number | null;
        pingUser?: boolean;
        replyPrefix?: string;
        interactionType?: import("../../domain/message/Message.ts").MessageInteractionType;
        interactionAuthorDiscordId?: string;
        thinkingText?: string;
        reuseHumanMessage?: boolean;
        fetchHistory?: boolean;
        ephemeralInstructionMessage?: string;
    }): Promise<void> {
        await Sentry.startSpan(
            {
                name: "Handle chat message",
                op: "chat.message.handle",
                attributes: {
                    "chat.message_id": params.message.id,
                    "chat.channel_id": params.message.channelId,
                    "chat.guild_id": params.message.guildId ?? DM_GUILD_TOKEN,
                    "chat.attachment_count": params.attachments?.length ?? 0,
                    "chat.has_reply": params.message.referencedMessageId !== null,
                },
            },
            async (span) => {
                await this.handleChatMessage.invokeAgentAndReply({ ...params, span });
            },
        );
    }
}
