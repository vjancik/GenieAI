import type { BaseMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { Span } from "@sentry/core";
import {
    ActionRowBuilder,
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    Client,
    Events,
    GatewayIntentBits,
    type Message,
} from "discord.js";
import type { GetNextPage } from "../../application/GetNextPage.ts";
import type { HandleDiscordMessage } from "../../application/HandleDiscordMessage.ts";
import { splitMarkdown } from "../../application/markdownSplitter.ts";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { IDiscordAttachmentRefetcher } from "../../application/ports/IDiscordAttachmentRefetcher.ts";
import type { RetryOrchestration } from "../../application/RetryOrchestration.ts";
import { llmTextToDiscordText } from "../../application/textTransformers.ts";
import type { AgentStatusUpdate, OnStatusUpdate } from "../../application/types/AgentStatus.ts";
import { AgentStatusType, assertNever } from "../../application/types/AgentStatus.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import { MessageIntent } from "../../domain/message/MessageIntent.ts";
import type { IMessagePageRepository } from "../../domain/message/MessagePage.ts";
import { InteractionLock } from "./InteractionLock.ts";
import type { StatusMessageUpdater } from "./StatusMessageUpdater.ts";
import { discordMessageToLlmText } from "./textTransformers.ts";

/** Custom ID for the Retry button attached to failed bot responses. */
const RETRY_BUTTON_ID = "retry_mention";

/** Custom ID for the Next Page button attached to paginated bot responses. */
const NEXT_PAGE_BUTTON_ID = "next_page";

/**
 * Maps each recognized bot command prefix to its corresponding {@link MessageIntent}.
 * Commands must appear at the start of a message, followed by at least one whitespace.
 * Matching is case-insensitive to accommodate phone auto-capitalization.
 *
 * Add new commands here — the rest of the pipeline picks up the intent automatically.
 */
export const DiscordCommand: Record<string, MessageIntent> = {
    "!ai": MessageIntent.GENERAL,
    "!aisearch": MessageIntent.SEARCH,
    "!aisummary": MessageIntent.SUMMARY,
};

/**
 * Builds a regex that matches any recognized command prefix at the start of the string,
 * followed by one or more whitespace characters. Case-insensitive.
 *
 * Longer commands are sorted first to prevent `!ai` from shadowing `!aisearch` / `!aisummary`.
 */
function buildCommandPrefixRegex(): RegExp {
    const sorted = Object.keys(DiscordCommand).sort((a, b) => b.length - a.length);
    const escaped = sorted.map((cmd) => cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^(?:${escaped.join("|")})\\s+`, "i");
}

const COMMAND_PREFIX_REGEX = buildCommandPrefixRegex();

/**
 * Determines the {@link MessageIntent} for a raw message string by checking for a
 * recognized command prefix at the start of the content (case-insensitive).
 * Returns {@link MessageIntent.UNKNOWN} if no command prefix is found.
 *
 * @param rawContent - The raw message string (before any stripping)
 */
export function parseMessageIntent(rawContent: string): MessageIntent {
    const match = COMMAND_PREFIX_REGEX.exec(rawContent);
    if (!match) return MessageIntent.UNKNOWN;
    // TYPE COERCION: match[0] is the matched prefix+whitespace; slice to get just the command token
    // and lowercase it to normalize for the map lookup.
    const command = match[0].trimEnd().toLowerCase();
    return DiscordCommand[command] ?? MessageIntent.UNKNOWN;
}

/**
 * Maps an agent status update to the Discord message string shown to the user
 * while the bot is processing. The switch is exhaustive: any new AgentStatusType
 * value without a matching case here is caught at compile time via `assertNever`.
 */
function statusUpdateContent(update: AgentStatusUpdate): string {
    switch (update.type) {
        case AgentStatusType.TRIAGE:
            return "Analyzing your request since";
        case AgentStatusType.DOWNLOADING_ATTACHMENTS:
            return "Downloading attachments since";
        case AgentStatusType.FETCHING_CONTENT:
            return "Fetching content since";
        case AgentStatusType.GENERATING:
            return "Generating response since";
        case AgentStatusType.SEARCHING:
            return "Searching the web since";
        default:
            return assertNever(update.type);
    }
}

/**
 * Determines whether the bot was explicitly @mentioned in a Discord message,
 * as opposed to a mention-by-reply (where Discord auto-includes the replied-to user).
 *
 * Uses discord.js `mentions.has()` with `ignoreRepliedUser: true` to exclude
 * the implicit mention Discord adds when a user replies to one of the bot's messages.
 * Only responds when the user intentionally typed "@BotName" in the message content.
 *
 * @param message - The Discord message to check
 * @param botUserId - The bot's Discord user ID
 */
export function isExplicitMention(message: Message, botUserId: string): boolean {
    return message.mentions.has(botUserId, { ignoreRepliedUser: true });
}

/**
 * Strips bot @mention tokens, the bot's managed role mention token, and any leading
 * command prefix (e.g. `!ai`, `!aisearch`) from the message content in a single pass.
 *
 * Discord encodes user mentions as `<@userId>` or `<@!userId>` (legacy nickname format),
 * and role mentions as `<@&roleId>`. The bot's managed role ID is sourced from the guild
 * member object at call time, so only the bot's own role mention is stripped rather than
 * all role mentions. In DMs there are no role mentions, so `botRoleId` will be null and
 * the role-stripping step is skipped entirely.
 *
 * Command stripping is case-insensitive to accommodate phone auto-capitalization.
 * The command prefix is only stripped when it appears at the start of the content,
 * followed by at least one whitespace character.
 *
 * @param message - The Discord message
 * @param botUserId - The bot's Discord user ID
 * @param botRoleId - The bot's managed role ID in this guild, or null for DMs
 * @returns Trimmed message content without the bot's user/role mention tokens or command prefix
 */
export function extractUserContent(message: Message, botUserId: string, botRoleId: string | null): string {
    // Strip command prefix first — it always appears at the message start before any mention tokens
    const stripped = message.content.replace(COMMAND_PREFIX_REGEX, "");
    // Strip bot user mention (<@userId> / <@!userId>) and optionally the bot's role mention (<@&roleId>)
    const mentionPattern = botRoleId
        ? new RegExp(`<@!?${botUserId}>|<@&${botRoleId}>`, "g")
        : new RegExp(`<@!?${botUserId}>`, "g");
    return stripped.replace(mentionPattern, "").trim();
}

/**
 * Manages the Discord gateway connection and dispatches incoming message events.
 *
 * Requires the following intents:
 * - Guilds: for guild metadata
 * - GuildMessages: for guild message events
 * - MessageContent: for reading message body (privileged intent, must be enabled in Dev Portal)
 * - DirectMessages: for DM support
 */
export class DiscordGateway {
    private readonly client: Client;
    private readonly interactionLock = new InteractionLock();

    constructor(
        private readonly token: string,
        private readonly messageHandler: HandleDiscordMessage,
        private readonly logger: Logger,
        private readonly statusUpdater: StatusMessageUpdater,
        private readonly messagePageRepo: IMessagePageRepository,
        private readonly getNextPage: GetNextPage,
        private readonly retryOrchestration: RetryOrchestration,
        private readonly messageRepo: IMessageRepository,
    ) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
        });

        this.registerEventHandlers();
    }

    /** Connect the bot to Discord's gateway. */
    async start(): Promise<void> {
        await this.client.login(this.token);
        this.logger.info({ tag: this.client.user?.tag }, "Discord bot connected");
    }

    /** Gracefully disconnect from Discord. */
    async stop(): Promise<void> {
        this.client.destroy();
        this.logger.info("Discord bot disconnected");
    }

    private registerEventHandlers(): void {
        this.client.once(Events.ClientReady, (client) => {
            this.logger.info({ tag: client.user.tag }, "Discord bot ready");
        });

        this.client.on(Events.MessageCreate, (message) => {
            // Fire-and-forget; errors are caught and logged internally
            void this.handleMessageCreate(message);
        });

        this.client.on(Events.InteractionCreate, (interaction) => {
            if (!interaction.isButton()) return;
            if (interaction.customId === RETRY_BUTTON_ID) {
                void this.handleRetryButton(interaction);
            } else if (interaction.customId === NEXT_PAGE_BUTTON_ID) {
                void this.handleNextPageButton(interaction);
            }
        });

        this.client.on(Events.Error, (err) => {
            this.logger.error({ err }, "Discord client error");
            Sentry.captureException(err);
        });
    }

    /**
     * Creates an {@link IDiscordAttachmentRefetcher} bound to a specific Discord channel.
     *
     * Fetches fresh CDN URLs for Discord attachments by re-fetching the message from the
     * API. Used by GeminiFileRefreshService in upload mode when a Gemini file URI has expired.
     * All messages in a reply chain share the same channel, so a single refetcher per request
     * is sufficient.
     *
     * @param channelId - The Discord channel snowflake to fetch messages from
     */
    private createAttachmentRefetcher(channelId: string): IDiscordAttachmentRefetcher {
        const client = this.client;
        return {
            async fetchAttachment(
                messageDiscordId: string,
                attachmentId: string,
            ): Promise<DiscordAttachmentInfo | null> {
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel?.isTextBased()) return null;
                    const msg = await channel.messages.fetch(messageDiscordId);
                    const att = msg.attachments.get(attachmentId);
                    if (!att) return null;
                    return {
                        id: att.id,
                        url: att.url,
                        proxyURL: att.proxyURL,
                        name: att.name ?? "attachment",
                        size: att.size,
                        contentType: att.contentType,
                    };
                } catch {
                    return null;
                }
            },
        };
    }

    /**
     * Shared post-processing step after the LLM produces a response.
     *
     * Handles: cancelling/deleting the thinking placeholder, applying the LLM→Discord
     * text transform, splitting paginated responses, building action row buttons,
     * sending the bot reply, saving it to the database, and persisting page state.
     *
     * Called by both {@link handleMessageCreate} and {@link handleRetryButton} so neither
     * duplicates the pagination or persistence logic.
     *
     * @param params.replyTarget - The user's original Discord message to reply to
     * @param params.response - Raw LLM response string (before Discord text transform)
     * @param params.newMessages - All LangChain messages generated during this turn
     * @param params.isFailure - Whether the response represents a failure
     * @param params.isRetryable - Whether a Retry button should be attached
     * @param params.thinkingMessage - Thinking placeholder to cancel and delete before sending
     * @param params.span - Active Sentry span for attribute recording
     */
    private async sendBotReply(params: {
        replyTarget: Message;
        response: string;
        newMessages: BaseMessage[];
        isFailure?: boolean;
        isRetryable?: boolean;
        thinkingMessagePromise: ReturnType<Message["reply"]>;
        span: Span;
    }): Promise<void> {
        const { replyTarget, response, newMessages, isFailure, isRetryable, thinkingMessagePromise, span } = params;

        // Cancel any pending status edit and delete the thinking placeholder before sending
        // the real response so the user is pinged on the final message, not the placeholder.
        thinkingMessagePromise
            .then((thinkingMessage) => {
                this.statusUpdater.cancel(thinkingMessage.id);
                thinkingMessage.delete();
            })
            .catch((err) => {
                this.logger.warn({ err }, "Failed to delete thinking message");
            });

        // Sanitize LLM output for Discord rendering
        const discordResponse = llmTextToDiscordText(response);

        // Attach a Retry button when the use case signals a retryable failure
        const retryRow =
            isFailure && isRetryable
                ? new ActionRowBuilder<ButtonBuilder>().addComponents(
                      new ButtonBuilder().setCustomId(RETRY_BUTTON_ID).setLabel("Retry").setStyle(ButtonStyle.Primary),
                  )
                : undefined;

        if (discordResponse.length > 2000) {
            // --- PAGINATED PATH ---
            const {
                content: page1Content,
                newOffset,
                pageCount: totalPages,
            } = splitMarkdown(discordResponse, 0, 2000, { pageCount: true });

            if (!totalPages) {
                throw new Error("splitMarkdown did not return pageCount for paginated content");
            }

            const nextPageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(NEXT_PAGE_BUTTON_ID)
                    .setLabel(`Next Page · Page 1 of ${totalPages}`)
                    .setStyle(ButtonStyle.Primary),
            );

            const components: ActionRowBuilder<ButtonBuilder>[] = [nextPageRow];
            if (retryRow) components.push(retryRow);

            const botReply = await replyTarget.reply({
                content: page1Content,
                components,
            });

            span.setAttributes({
                "discord.paginated": true,
                "discord.total_pages": totalPages,
            });

            // messages row must exist before messagePageRepo.save (FK constraint)
            await this.messageHandler.saveBotResponse({
                botDiscordMessageId: botReply.id,
                repliesToDiscordId: replyTarget.id,
                channelId: botReply.channelId,
                guildId: botReply.guildId,
                newMessages,
            });
            // firstPageDiscordMessageId = botReply.id for the first page (same message)
            await this.messagePageRepo.save({
                botDiscordMessageId: botReply.id,
                firstPageDiscordMessageId: botReply.id,
                endOffset: newOffset,
                currentPage: 1,
                totalPages,
            });
        } else {
            // --- NON-PAGINATED PATH ---
            const botReply = await replyTarget.reply({
                content: discordResponse,
                ...(retryRow && { components: [retryRow] }),
            });

            span.setAttributes({ "discord.paginated": false });

            await this.messageHandler.saveBotResponse({
                botDiscordMessageId: botReply.id,
                repliesToDiscordId: replyTarget.id,
                channelId: botReply.channelId,
                guildId: botReply.guildId,
                newMessages,
            });
        }

        span.setAttributes({
            "discord.response_length": response.length,
            "discord.is_failure": isFailure ?? false,
        });
    }

    /**
     * Handles a Retry button click on a failed bot response.
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
    private async handleRetryButton(interaction: ButtonInteraction): Promise<void> {
        if (this.interactionLock.isLocked(interaction.message.id, interaction.customId)) {
            await interaction.deferUpdate();
            return;
        }
        this.interactionLock.setLocked(interaction.message.id, interaction.customId);
        try {
            const originalMessageId = interaction.message.reference?.messageId;
            const channel = interaction.channel;

            let originalMessage: Message | undefined;
            if (originalMessageId && channel?.isTextBased()) {
                try {
                    originalMessage = await channel.messages.fetch(originalMessageId);
                } catch {
                    // fetch failed — original message was deleted
                }
            }

            if (!originalMessage) {
                // Original message is gone or unreachable — remove the button and notify ephemerally
                await Promise.allSettled([
                    interaction.reply({
                        content: "Original message is missing, retry is no longer possible.",
                        ephemeral: true,
                    }),
                    interaction.message.edit({ components: [] }),
                ]);
                return;
            }

            // Acknowledge the interaction immediately so Discord doesn't show "interaction failed"
            await interaction.deferUpdate();

            // Delete the old failed bot reply before sending a fresh response
            await interaction.message.delete().catch((err) => {
                this.logger.warn({ err }, "Failed to delete old failed bot reply on retry");
            });

            await Sentry.startSpan(
                {
                    name: "Handle Retry button",
                    op: "discord.interaction.retry",
                    attributes: {
                        "discord.original_message_id": originalMessage.id,
                        "discord.channel_id": originalMessage.channelId,
                    },
                },
                async (span) => {
                    const intent = parseMessageIntent(originalMessage.content);

                    // Check whether the human message was already saved to DB.
                    // If it was, the failure was in the orchestrator (Scenario A).
                    // If not, the failure was earlier in the pipeline (Scenario B).
                    const humanRecord = await this.messageRepo.findByDiscordMessageId(originalMessage.id);

                    if (humanRecord) {
                        // --- Scenario A: human message exists, re-run orchestration only ---
                        span.setAttribute("discord.retry_scenario", "A");

                        const attachmentRefetcher = this.createAttachmentRefetcher(originalMessage.channelId);

                        // Send thinking placeholder — awaited so we have the message before
                        // the first status update can arrive.
                        let thinkingMessagePromise = originalMessage.reply({
                            content: `*Retrying since <t:${Math.round(Date.now() / 1000)}:R>*`,
                            allowedMentions: { repliedUser: false },
                        });

                        // Wrap thinkingMessage in a promise so onStatusUpdate can share the
                        // same lazy-resolution pattern used in handleMessageCreate.

                        const onStatusUpdate: OnStatusUpdate = (update) => {
                            thinkingMessagePromise = thinkingMessagePromise.then((msg) => {
                                this.statusUpdater.scheduleUpdate(
                                    originalMessage.channelId,
                                    msg.id,
                                    async (content) =>
                                        void (await msg.edit({
                                            content: `*${content} <t:${Math.round(Date.now() / 1000)}:R>*`,
                                            allowedMentions: { repliedUser: false },
                                        })),
                                    statusUpdateContent(update),
                                );
                                return msg;
                            });
                        };

                        const { response, newMessages, isFailure, isRetryable } = await this.retryOrchestration.execute(
                            {
                                humanDiscordMessageId: originalMessage.id,
                                intent,
                                onStatusUpdate,
                                attachmentRefetcher,
                            },
                        );

                        await this.sendBotReply({
                            replyTarget: originalMessage,
                            response,
                            newMessages,
                            isFailure,
                            isRetryable,
                            thinkingMessagePromise,
                            span,
                        });
                    } else {
                        // --- Scenario B: human message not in DB, run full pipeline ---
                        span.setAttribute("discord.retry_scenario", "B");
                        await this.handleMessageCreate(originalMessage);
                    }
                },
            );
        } finally {
            this.interactionLock.clearLock(interaction.message.id, interaction.customId);
        }
    }

    /**
     * Handles a Next Page button click on a paginated bot response.
     *
     * Retrieves the pending page state from the DB via the GetNextPage use case,
     * sends the next page as a Discord reply to the current bot message, updates
     * the DB state, and removes the button from the old message.
     *
     * If the page state is missing (e.g. stale button), removes the button and returns.
     */
    private async handleNextPageButton(interaction: ButtonInteraction): Promise<void> {
        if (this.interactionLock.isLocked(interaction.message.id, interaction.customId)) {
            await interaction.deferUpdate();
            return;
        }
        this.interactionLock.setLocked(interaction.message.id, interaction.customId);
        try {
            // Acknowledge immediately to prevent Discord's "interaction failed" timeout
            await interaction.deferUpdate();

            const currentBotMessageId = interaction.message.id;

            await Sentry.startSpan(
                {
                    name: "Handle Next Page button",
                    op: "discord.interaction.next_page",
                    attributes: { "discord.message_id": currentBotMessageId },
                },
                async (span) => {
                    // Step 1: Compute next page content via use case
                    let result: Awaited<ReturnType<GetNextPage["execute"]>>;
                    try {
                        result = await this.getNextPage.execute({ botDiscordMessageId: currentBotMessageId });
                    } catch (err) {
                        this.logger.error({ err, currentBotMessageId }, "Failed to compute next page");
                        Sentry.captureException(err);
                        await interaction.message.edit({ components: [] }).catch(() => {});
                        return;
                    }

                    if (!result) {
                        // No pending page state — stale button click
                        await interaction.message.edit({ components: [] }).catch((err) => {
                            this.logger.warn({ err, currentBotMessageId }, "Failed to remove stale Next Page button");
                        });
                        return;
                    }

                    span.setAttributes({
                        "discord.page": result.currentPage,
                        "discord.total_pages": result.totalPages,
                        "discord.is_last_page": result.isLast,
                    });

                    // Step 2: Build component row for next message (omit button on last page)
                    const nextPageRow = result.isLast
                        ? undefined
                        : new ActionRowBuilder<ButtonBuilder>().addComponents(
                              new ButtonBuilder()
                                  .setCustomId(NEXT_PAGE_BUTTON_ID)
                                  .setLabel(`Next Page · Page ${result.currentPage} of ${result.totalPages}`)
                                  .setStyle(ButtonStyle.Primary),
                          );

                    // Step 3: Send the next page as a reply to the current bot message
                    let newBotMessage: Awaited<ReturnType<Message["reply"]>>;
                    try {
                        newBotMessage = await interaction.message.reply({
                            content: result.content,
                            ...(nextPageRow && { components: [nextPageRow] }),
                        });
                    } catch (err) {
                        this.logger.error({ err, currentBotMessageId }, "Failed to send next page reply");
                        Sentry.captureException(err);
                        return;
                    }

                    // Step 4: Persist the messages row first — messagePageRepo.save has a FK on it,
                    // so if this throws the remaining cleanup is skipped entirely.
                    await this.messageHandler.saveBotResponse({
                        botDiscordMessageId: newBotMessage.id,
                        repliesToDiscordId: currentBotMessageId,
                        channelId: newBotMessage.channelId,
                        guildId: newBotMessage.guildId,
                        newMessages: [],
                    });

                    await Promise.allSettled([
                        // Save new pending page state if there are more pages after this one.
                        // firstPageDiscordMessageId is propagated from the page state so all rows
                        // in this response chain point to the same first-page messages row.
                        !result.isLast
                            ? this.messagePageRepo
                                  .save({
                                      botDiscordMessageId: newBotMessage.id,
                                      firstPageDiscordMessageId: result.firstPageDiscordMessageId,
                                      endOffset: result.newOffset,
                                      currentPage: result.currentPage,
                                      totalPages: result.totalPages,
                                  })
                                  .catch((err) => {
                                      this.logger.error({ err }, "Failed to save next message page state");
                                  })
                            : Promise.resolve(),

                        // Remove the Next Page button from the OLD bot message
                        interaction.message.edit({ components: [] }).catch((err) => {
                            this.logger.warn(
                                { err, currentBotMessageId },
                                "Failed to remove Next Page button from old message",
                            );
                        }),
                    ]);

                    this.logger.info(
                        {
                            currentBotMessageId,
                            newBotMessageId: newBotMessage.id,
                            page: result.currentPage,
                            totalPages: result.totalPages,
                        },
                        "Sent next page",
                    );
                },
            );
        } finally {
            this.interactionLock.clearLock(interaction.message.id, interaction.customId);
        }
    }

    private async handleMessageCreate(message: Message): Promise<void> {
        // Ignore all bot messages (including our own) to prevent feedback loops
        if (message.author.bot) return;

        const botUserId = this.client.user?.id;
        if (!botUserId) return;

        // botRole is the managed role Discord auto-creates for the bot in each guild; null in DMs
        const botRoleId = message.guild?.members.me?.roles.botRole?.id ?? null;
        // Parse intent from raw content before stripping, so the command prefix is visible
        const intent = parseMessageIntent(message.content);

        // Only respond to explicit @mentions or recognized command prefixes
        if (intent === MessageIntent.UNKNOWN && !isExplicitMention(message, botUserId)) return;
        const userContent = extractUserContent(message, botUserId, botRoleId);
        const attachments: DiscordAttachmentInfo[] = [...message.attachments.values()].map((a) => ({
            id: a.id,
            url: a.url,
            proxyURL: a.proxyURL,
            name: a.name ?? "attachment",
            size: a.size,
            contentType: a.contentType,
        }));

        if (!userContent && attachments.length === 0) {
            await message.reply("Hi! Mention me with a question or a request.");
            return;
        }

        this.logger.info(
            {
                discordMessageId: message.id,
                channelId: message.channelId,
                referencedMessageId: message.reference?.messageId ?? null,
                attachmentCount: attachments.length,
            },
            "Processing bot message",
        );

        // Declared outside the span so the catch handler can access it even if the
        // span callback threw before the thinking message was sent.
        let thinkingMessagePromise: ReturnType<Message["reply"]>;

        await Sentry.startSpan(
            {
                name: "Handle Discord message",
                op: "discord.message.handle",
                attributes: {
                    "discord.message_id": message.id,
                    "discord.channel_id": message.channelId,
                    "discord.guild_id": message.guildId ?? undefined,
                    "discord.attachment_count": attachments.length,
                    "discord.has_reply": message.reference?.messageId !== undefined,
                },
            },
            async (span) => {
                try {
                    // Send the "Thinking" placeholder immediately — fire-and-forget (not awaited)
                    // so it does not delay AI processing. Sent as a reply with allowedMentions
                    // suppressed so the user is not pinged at this stage. The promise is resolved
                    // lazily on the first status update, or awaited when we need to delete it
                    // after the real response is sent.
                    thinkingMessagePromise = message.reply({
                        content: `*Thinking since <t:${Math.round(Date.now() / 1000)}:R>*`,
                        allowedMentions: { repliedUser: false },
                    });

                    const attachmentRefetcher = this.createAttachmentRefetcher(message.channelId);

                    const onStatusUpdate: OnStatusUpdate = (update) => {
                        // Await the thinking message promise so we have the message ID before
                        // scheduling an edit. The promise resolves on the first call and is
                        // replaced with a pre-resolved promise for all subsequent status updates.
                        // thinkingMessagePromise is always assigned before onStatusUpdate
                        // can be called — the assignment is on the line above this closure.
                        thinkingMessagePromise = thinkingMessagePromise?.then((thinkingMessage) => {
                            this.statusUpdater.scheduleUpdate(
                                message.channelId,
                                thinkingMessage.id,
                                async (content) =>
                                    void (await thinkingMessage.edit({
                                        content: `*${content} <t:${Math.round(Date.now() / 1000)}:R>*`,
                                        allowedMentions: {
                                            repliedUser: false,
                                        },
                                    })),
                                statusUpdateContent(update),
                            );
                            return thinkingMessage;
                        });
                    };

                    // Resolve display name with guild-aware priority:
                    // member.displayName = nickname ?? globalName ?? username (discord.js computed)
                    // falls back to author.displayName (globalName ?? username) for DMs
                    const userName = message.member?.displayName ?? message.author.displayName;

                    // Enrich the stripped content with sender attribution for LLM context
                    const llmContent = discordMessageToLlmText(userName, userContent);

                    // handle() never throws — errors are caught internally and returned as a response
                    const { response, newMessages, isFailure, isRetryable } = await this.messageHandler.handle({
                        discordMessageId: message.id,
                        referencedMessageId: message.reference?.messageId ?? null,
                        channelId: message.channelId,
                        guildId: message.guildId,
                        userContent: llmContent,
                        attachments,
                        intent,
                        onStatusUpdate,
                        attachmentRefetcher,
                    });

                    await this.sendBotReply({
                        replyTarget: message,
                        response,
                        newMessages,
                        isFailure,
                        isRetryable,
                        thinkingMessagePromise,
                        span,
                    });
                } catch (err) {
                    this.logger.error({ err, discordMessageId: message.id }, "Failed to send or persist bot reply");
                    Sentry.captureException(err);

                    // Attempt to edit the thinking message with an error notice. Guard
                    // against undefined in case the error was thrown before the thinking
                    // message send was initiated. It may also already be deleted if the
                    // error occurred after thinkingMessage.delete(), so swallow any failure.
                    thinkingMessagePromise
                        ?.then((thinkingMessage) => {
                            this.statusUpdater.cancel(thinkingMessage.id);
                            return thinkingMessage.edit("Sorry, I encountered an error processing your request.");
                        })
                        .catch((editErr) => {
                            this.logger.warn(
                                { editErr, discordMessageId: message.id },
                                "Failed to edit thinking message with error notice",
                            );
                        });
                }
            },
        );
    }
}
