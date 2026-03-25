import * as Sentry from "@sentry/bun";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import { MessageIntent } from "../../domain/message/MessageIntent.ts";
import { parseMessageIntent } from "../helpers/parseMessageIntent.ts";
import type {
    IChatClientBot,
    IChatClientButtonInteraction,
    IChatClientChannel,
    IChatClientMessage,
} from "../ports/chat/IChatClient.ts";
import type { IInteractionLock } from "../ports/IInteractionLock.ts";
import type { Logger } from "../types/Logger.ts";
import type { HandleChatMessageUseCase } from "./HandleChatMessage.ts";

/** Sentinel value stored as guild_id for DM messages, which have no guild. */
const DM_GUILD_TOKEN = "@me";

/** Custom ID for the Retry button attached to failed bot responses. */
const RETRY_BUTTON_ID = "retry_mention";

/**
 * Returns the button array for `message` with the button matching `removeId` filtered out.
 * Preserves all other buttons so, e.g., removing the Retry button leaves any co-located
 * Next Page button intact. Passing the result to `message.edit({ buttons })` replaces
 * the row in-place.
 */
function withoutButton(message: IChatClientMessage, removeId: string): IChatClientMessage["buttons"] {
    return message.buttons.filter((b) => b.customId !== removeId);
}

/**
 * Application use case: handles a Retry button click on a failed bot response.
 *
 * Two scenarios:
 * - **Scenario A** (human message in DB): the failure occurred in the orchestrator.
 *   Re-runs only the orchestration using the saved conversation chain. Skips
 *   attachment re-download/re-upload and human message re-save.
 * - **Scenario B** (human message NOT in DB): the failure occurred before or during
 *   the human message save (e.g. attachment download/upload failure, DB error).
 *   Falls back to the full message handling pipeline.
 *
 * In both scenarios, the old failed bot reply is deleted before sending a new response.
 */
export class HandleRetryUseCase {
    /**
     * @param handleChatMessage - Use case for the full message handling pipeline
     * @param messageRepo - Repository for reading/deleting message records
     * @param bot - Chat client bot adapter for reading the current bot user ID
     * @param logger - Logger instance
     * @param interactionLock - Lock to prevent duplicate concurrent button processing
     */
    constructor(
        private readonly handleChatMessage: HandleChatMessageUseCase,
        private readonly messageRepo: IMessageRepository,
        private readonly bot: IChatClientBot,
        private readonly logger: Logger,
        private readonly interactionLock: IInteractionLock,
    ) {}

    /**
     * Executes the Retry flow for a button interaction.
     *
     * Acknowledges the interaction, resolves the original human message, inspects the
     * DB chain to determine which scenario applies, then deletes the old failed reply
     * and dispatches to the appropriate re-run path.
     */
    async execute(interaction: IChatClientButtonInteraction): Promise<void> {
        const originalMessageId = interaction.message.referencedMessageId;
        const channel = interaction.channel;

        let originalMessage: IChatClientMessage | undefined;
        if (originalMessageId && channel) {
            try {
                originalMessage = await channel.fetchMessage(originalMessageId);
            } catch {
                // fetch failed — original message was deleted
            }
        }

        if (!originalMessage) {
            // Original message is gone or unreachable — remove the button and notify ephemerally
            await Promise.allSettled([
                interaction.reply({
                    content: "Original message is missing, retry is no longer possible.",
                    isEphemeral: true,
                }),
                interaction.message.edit({
                    buttons: withoutButton(interaction.message, RETRY_BUTTON_ID),
                }),
            ]);
            return;
        }

        // Acknowledge the interaction immediately so Discord doesn't show "interaction failed"
        await interaction.deferUpdate();

        await Sentry.startSpan(
            {
                name: "Handle Retry button",
                op: "chat.interaction.retry",
                attributes: {
                    // NOTE: pass in to use case when extending
                    "chat.platform": "Discord",
                    "chat.command.type": "Button",
                    "chat.original_message_id": originalMessage.id,
                    "chat.channel_id": originalMessage.channelId,
                },
            },
            async (span) => {
                // Fetch the tail of the reply chain starting from the failed bot reply.
                // With limit=2 we get at most [humanMsg, botReply] in chronological order.
                // The bot reply record (last) carries retriesLeft, usedFallback, and interactionType;
                // the human record (second-to-last) confirms whether the human message was saved
                // (Scenario A vs B) and provides the original author ID for the eligibility check.
                const guildId = originalMessage.guildId ?? DM_GUILD_TOKEN;
                const chain = await this.messageRepo.fetchChain({
                    startDiscordMessageId: interaction.message.id,
                    channelId: originalMessage.channelId,
                    guildId,
                    limit: 2,
                });

                // chain is ordered chronologically: [humanMsg, botReply] when both exist,
                // or [botReply] / [] when the human message was never saved (Scenario B).
                const botRecord = chain.at(-1);
                const humanRecord = chain.length >= 2 ? chain.at(-2) : undefined;

                // Decrement retriesLeft from the stored bot reply row — each click consumes one retry.
                // null if not set or record missing (sendBotReply will fall back to defaultRetriesLeft).
                const storedRetriesLeft = botRecord?.retriesLeft ?? null;
                const retriesLeft = storedRetriesLeft !== null ? storedRetriesLeft - 1 : null;

                // Reconstruct intent and reply options from the stored interaction type.
                // For summary_command the original message has no command prefix, so parseMessageIntent
                // would return UNKNOWN — we must use the DB value instead.
                const isSummaryCommand = botRecord?.interactionType === "summary_command";
                const intent = isSummaryCommand ? MessageIntent.SUMMARY : parseMessageIntent(originalMessage.content);

                // Mirror the self-reply logic from HandleSummarizeUseCase: if the invoker
                // is the same user as the message author, Discord's reply mechanism already pings
                // them and allowedMentions.repliedUser suppression would strip an explicit prefix.
                const isSelfReply =
                    isSummaryCommand && botRecord?.interactionAuthorDiscordId === humanRecord?.discordAuthorId;
                const pingUser = !isSummaryCommand || isSelfReply;
                const replyPrefix =
                    isSummaryCommand && !isSelfReply && botRecord?.interactionAuthorDiscordId
                        ? `<@${botRecord.interactionAuthorDiscordId}>`
                        : undefined;

                // Gate: when the response was a successful fallback (usedFallback=true, isFailure=false),
                // only the original prompter may retry — it's their call whether the response is
                // unsatisfactory. Failed responses are open to anyone since retrying benefits all.
                if (botRecord?.usedFallback && humanRecord?.role === "human") {
                    const originalAuthorId = humanRecord.discordAuthorId;
                    if (interaction.userId !== originalAuthorId) {
                        await interaction.followUp({
                            content: "*This message was generated for someone else and can only be retried by them.*",
                            isEphemeral: true,
                        });
                        return;
                    }
                }

                // Acquire the per-button lock only for eligible interactions, so ineligible users
                // (checked above) don't block the real prompter from clicking.
                if (this.interactionLock.isLocked(interaction.message.id, interaction.customId)) {
                    span.setAttribute("chat.retry_skipped", "locked");
                    return;
                }
                this.interactionLock.setLocked(interaction.message.id, interaction.customId);
                try {
                    // Delete the old failed bot reply from Discord before sending a fresh response.
                    // DB deletion happens later after retriesLeft has been read.
                    await interaction.message.delete().catch((err) => {
                        this.logger.warn({ err }, "Failed to delete old failed bot reply from Discord on retry");
                    });

                    // If the deleted message had a sources follow-up, clean it up too.
                    if (channel) {
                        this.deleteDanglingSourcesMessageOptimistically(
                            channel,
                            interaction.message.id,
                            originalMessage.channelId,
                            guildId,
                        );
                    }

                    // Delete the old failed bot reply from DB now that retriesLeft has been read.
                    // Fire-and-forget — failure here doesn't block the retry from proceeding.
                    this.messageRepo
                        .deleteByDiscordMessageId({
                            discordMessageId: interaction.message.id,
                            channelId: originalMessage.channelId,
                            guildId,
                        })
                        .catch((err) => {
                            this.logger.warn({ err }, "Failed to delete old failed bot reply from DB on retry");
                        });

                    if (humanRecord?.role === "human") {
                        // --- Scenario A: human message exists, re-run orchestration only ---
                        // reuseHumanMessage skips re-building/re-persisting the human message row
                        // and reconstructs the full conversation chain from DB instead.
                        span.setAttribute("chat.retry_scenario", "A");
                        await this.invokeAgentWithMessage({
                            message: originalMessage,
                            userContent: null,
                            attachments: null,
                            intent,
                            retriesLeft,
                            pingUser,
                            replyPrefix,
                            interactionType: botRecord?.interactionType ?? "message_create",
                            interactionAuthorDiscordId: botRecord?.interactionAuthorDiscordId ?? undefined,
                            thinkingText: "Retrying",
                            reuseHumanMessage: true,
                        });
                    } else {
                        // --- Scenario B: human message not in DB, run full pipeline ---
                        span.setAttribute("chat.retry_scenario", "B");
                        await this.handleChatMessage.execute({
                            message: originalMessage,
                            shutdownPending: false,
                            isRateLimited: false,
                            retriesLeft,
                            interactionType: "message_create",
                        });
                    }
                } finally {
                    this.interactionLock.clearLock(interaction.message.id, interaction.customId);
                }
            },
        );
    }

    // NOTE: A naive implementation for a rare usecase, could be made more robust by extending the database
    /**
     * After deleting a bot message on Retry, opportunistically deletes any dangling
     * sources follow-up that replied to it. Web Search responses send a separate
     * "*Sources: …*" message that would otherwise be left orphaned.
     *
     * Fetches up to 10 messages sent after the deleted message in the same channel,
     * finds the first one that is the bot's own message, replies to the deleted
     * message, and starts with "*Sources: " — then deletes it from Discord and the DB.
     *
     * Intentionally fire-and-forget: errors are logged but never propagate.
     *
     * @param channel - The text channel the deleted message was in
     * @param deletedMessageId - Snowflake ID of the message that was just deleted
     * @param channelId - Channel ID for DB deletion
     * @param guildId - Guild ID for DB deletion
     */
    private deleteDanglingSourcesMessageOptimistically(
        channel: IChatClientChannel,
        deletedMessageId: string,
        channelId: string,
        guildId: string,
    ): void {
        const botId = this.bot.userId;

        channel
            .fetchMessagesAfter(deletedMessageId, 10)
            .then((fetched) => {
                const sourcesMsg = fetched.find(
                    (msg) =>
                        msg.authorId === botId &&
                        msg.referencedMessageId === deletedMessageId &&
                        // NOTE this might drift from sources message formatting
                        msg.content.startsWith("*Sources: "),
                );
                if (!sourcesMsg) return;

                // Delete from Discord — fire-and-forget
                sourcesMsg.delete().catch((err) => {
                    this.logger.warn({ err }, "Failed to delete dangling sources message from Discord on retry");
                });

                // Delete from DB — fire-and-forget
                this.messageRepo
                    .deleteByDiscordMessageId({ discordMessageId: sourcesMsg.id, channelId, guildId })
                    .catch((err) => {
                        this.logger.warn({ err }, "Failed to delete dangling sources message from DB on retry");
                    });
            })
            .catch((err) => {
                this.logger.warn({ err }, "Failed to fetch messages when cleaning up dangling sources on retry");
            });
    }

    /**
     * Core agent invocation shared by Scenario A retry path. Delegates to
     * {@link HandleChatMessageUseCase.invokeAgentAndReply}, wrapping with a Sentry span.
     */
    private async invokeAgentWithMessage(params: {
        message: IChatClientMessage;
        userContent: string | null;
        attachments: IChatClientMessage["attachments"] | null;
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
                    // NOTE: pass in to use case when extending
                    "chat.platform": "Discord",
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
