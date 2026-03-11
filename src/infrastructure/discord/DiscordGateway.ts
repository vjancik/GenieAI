import * as Sentry from "@sentry/bun";
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
import type { HandleDiscordMessage } from "../../application/HandleDiscordMessage.ts";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { IDiscordAttachmentRefetcher } from "../../application/ports/IDiscordAttachmentRefetcher.ts";
import type { AgentStatusUpdate, OnStatusUpdate } from "../../application/types/AgentStatus.ts";
import { AgentStatusType, assertNever } from "../../application/types/AgentStatus.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { StatusMessageUpdater } from "./StatusMessageUpdater.ts";

/** Custom ID for the Retry button attached to failed bot responses. */
const RETRY_BUTTON_ID = "retry_mention";

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
 * Strips bot @mention tokens and the bot's managed role mention token from the message content.
 * Discord encodes user mentions as `<@userId>` or `<@!userId>` (legacy nickname format),
 * and role mentions as `<@&roleId>`.
 *
 * The bot's managed role ID is sourced from the guild member object at call time, so only
 * the bot's own role mention is stripped rather than all role mentions. In DMs there are no
 * role mentions, so `botRoleId` will be null and the role-stripping step is skipped entirely.
 *
 * @param message - The Discord message
 * @param botUserId - The bot's Discord user ID
 * @param botRoleId - The bot's managed role ID in this guild, or null for DMs
 * @returns Trimmed message content without the bot's user/role mention tokens
 */
export function extractUserContent(message: Message, botUserId: string, botRoleId: string | null): string {
    let content = message.content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "");
    if (botRoleId) {
        content = content.replace(new RegExp(`<@&${botRoleId}>`, "g"), "");
    }
    return content.trim();
}

/**
 * Manages the Discord gateway connection and dispatches incoming mention events.
 *
 * Requires the following intents:
 * - Guilds: for guild metadata
 * - GuildMessages: for guild message events
 * - MessageContent: for reading message body (privileged intent, must be enabled in Dev Portal)
 * - DirectMessages: for DM support
 */
export class DiscordGateway {
    private readonly client: Client;

    constructor(
        private readonly token: string,
        private readonly mentionHandler: HandleDiscordMessage,
        private readonly logger: Logger,
        private readonly statusUpdater: StatusMessageUpdater,
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
            if (interaction.customId !== RETRY_BUTTON_ID) return;
            void this.handleRetryButton(interaction);
        });

        this.client.on(Events.Error, (err) => {
            this.logger.error({ err }, "Discord client error");
            Sentry.captureException(err);
        });
    }

    /**
     * Handles a Retry button click on a failed bot response.
     *
     * Fetches the original user message the bot was replying to, then re-invokes
     * the message handler as if the user had sent that message again. If the original
     * message no longer exists, removes the Retry button and replies ephemerally.
     */
    private async handleRetryButton(interaction: ButtonInteraction): Promise<void> {
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

        await this.handleMessageCreate(originalMessage);
    }

    private async handleMessageCreate(message: Message): Promise<void> {
        // Ignore all bot messages (including our own) to prevent feedback loops
        if (message.author.bot) return;

        const botUserId = this.client.user?.id;
        if (!botUserId) return;

        // Only respond to explicit @mentions, not reply-mentions
        if (!isExplicitMention(message, botUserId)) return;

        // botRole is the managed role Discord auto-creates for the bot in each guild; null in DMs
        const botRoleId = message.guild?.members.me?.roles.botRole?.id ?? null;
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
            "Processing bot mention",
        );

        // Declared outside the span so the catch handler can access it even if the
        // span callback threw before the thinking message was sent.
        let thinkingMessagePromise: Promise<Message> | undefined;

        await Sentry.startSpan(
            {
                name: "Handle Discord mention",
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

                    /**
                     * Per-request attachment refetcher: closes over the discord.js client and
                     * the current channelId. All messages in a reply chain share the same channel,
                     * so this is valid for refetching any historical message in the chain.
                     * Used by GeminiFileRefreshService in upload mode to get fresh CDN URLs.
                     */
                    const channelId = message.channelId;
                    const client = this.client;
                    // TODO: wouldn't this be cleaner as a lambda instead of a module? Unsure
                    const attachmentRefetcher: IDiscordAttachmentRefetcher = {
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

                    // handle() never throws — errors are caught internally and returned as a response
                    const { response, newMessages, isFailure, isRetryable } = await this.mentionHandler.handle({
                        discordMessageId: message.id,
                        referencedMessageId: message.reference?.messageId ?? null,
                        channelId: message.channelId,
                        guildId: message.guildId,
                        userContent,
                        attachments,
                        onStatusUpdate,
                        attachmentRefetcher,
                    });

                    // Truncate to Discord's 2000-character limit
                    const truncated = response.length > 2000;
                    const safeResponse = truncated ? `${response.slice(0, 1997)}...` : response;

                    span.setAttributes({
                        "discord.response_truncated": truncated,
                        "discord.response_length": response.length,
                        "discord.is_failure": isFailure ?? false,
                    });

                    // Resolve the thinking message and cancel any pending status edit
                    thinkingMessagePromise.then((thinkingMessage) => {
                        this.statusUpdater.cancel(thinkingMessage.id);
                        // Delete the thinking placeholder and reply with the final response so
                        // the user is pinged when the response is actually ready.
                        thinkingMessage.delete();
                    });

                    // Attach a Retry button when the use case signals a retryable failure
                    const retryRow =
                        isFailure && isRetryable
                            ? new ActionRowBuilder<ButtonBuilder>().addComponents(
                                  new ButtonBuilder()
                                      .setCustomId(RETRY_BUTTON_ID)
                                      .setLabel("Retry")
                                      .setStyle(ButtonStyle.Primary),
                              )
                            : undefined;

                    const botReply = await message.reply({
                        content: safeResponse,
                        ...(retryRow && { components: [retryRow] }),
                    });

                    // Persist only after the final response is successfully sent
                    await this.mentionHandler.saveBotResponse({
                        botDiscordMessageId: botReply.id,
                        repliesToDiscordId: message.id,
                        channelId: botReply.channelId,
                        guildId: botReply.guildId,
                        newMessages,
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
