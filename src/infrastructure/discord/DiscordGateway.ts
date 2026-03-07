import type { BaseMessage } from "@langchain/core/messages";
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { IDiscordAttachmentRefetcher } from "../../application/ports/IDiscordAttachmentRefetcher.ts";
import type {
    AgentStatusUpdate,
    OnStatusUpdate,
} from "../../application/types/AgentStatus.ts";
import {
    AgentStatusType,
    assertNever,
} from "../../application/types/AgentStatus.ts";
import { DiscordError } from "../../domain/errors/AppError.ts";
import type { Logger } from "../logging/logger.ts";
import type { StatusMessageUpdater } from "./StatusMessageUpdater.ts";

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
export function isExplicitMention(
    message: Message,
    botUserId: string,
): boolean {
    return message.mentions.has(botUserId, { ignoreRepliedUser: true });
}

/**
 * Strips bot @mention tokens and all role mention tokens from the message content.
 * Discord encodes user mentions as `<@userId>` or `<@!userId>` (legacy nickname format),
 * and role mentions as `<@&roleId>`. Role mentions are stripped unconditionally since
 * the bot's role ID is not available here and they are always noise in the user's intent.
 *
 * @param message - The Discord message
 * @param botUserId - The bot's Discord user ID
 * @returns Trimmed message content without bot mention or role mention tokens
 */
export function extractUserContent(
    message: Message,
    botUserId: string,
): string {
    return (
        message.content
            .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
            // TODO: pass the bot default server role ID to selectively strip only the bot's role mention, if present
            .replace(/<@&\d+>/g, "")
            .trim()
    );
}

/** Callback invoked when the bot receives a valid explicit mention. */
export type MentionHandler = (params: {
    discordMessageId: string;
    referencedMessageId: string | null;
    channelId: string;
    guildId: string | null;
    userContent: string;
    attachments: DiscordAttachmentInfo[];
    onStatusUpdate?: OnStatusUpdate;
    attachmentRefetcher?: IDiscordAttachmentRefetcher;
}) => Promise<{ response: string; newMessages: BaseMessage[] }>;

/** Callback invoked after the bot's reply is sent, to persist the bot's message. */
export type BotReplySavedCallback = (params: {
    botDiscordMessageId: string;
    repliesToDiscordId: string;
    channelId: string;
    guildId: string | null;
    newMessages: BaseMessage[];
}) => Promise<void>;

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
        private readonly mentionHandler: MentionHandler,
        private readonly botReplySaved: BotReplySavedCallback,
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
        this.logger.info(
            { tag: this.client.user?.tag },
            "Discord bot connected",
        );
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

        this.client.on(Events.Error, (err) => {
            this.logger.error({ err }, "Discord client error");
        });
    }

    private async handleMessageCreate(message: Message): Promise<void> {
        // Ignore all bot messages (including our own) to prevent feedback loops
        if (message.author.bot) return;

        const botUserId = this.client.user?.id;
        if (!botUserId) return;

        // Only respond to explicit @mentions, not reply-mentions
        if (!isExplicitMention(message, botUserId)) return;

        const userContent = extractUserContent(message, botUserId);
        const attachments: DiscordAttachmentInfo[] = [
            ...message.attachments.values(),
        ].map((a) => ({
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

        /**
         * Per-request attachment refetcher: closes over the discord.js client and
         * the current channelId. All messages in a reply chain share the same channel,
         * so this is valid for refetching any historical message in the chain.
         * Used by GeminiFileRefreshService in upload mode to get fresh CDN URLs.
         */
        const channelId = message.channelId;
        const client = this.client;
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

        // Send the "Thinking" placeholder immediately so the user gets instant feedback
        const thinkingMessage = await message.reply(
            `*Thinking since <t:${Math.round(Date.now() / 1000)}:R>*`,
        );

        const onStatusUpdate: OnStatusUpdate = (update) => {
            this.statusUpdater.scheduleUpdate(
                message.channelId,
                thinkingMessage.id,
                async (content) =>
                    void (await thinkingMessage.edit(
                        `*${content} <t:${Math.round(Date.now() / 1000)}:R>*`,
                    )),
                statusUpdateContent(update),
            );
        };

        try {
            const { response, newMessages } = await this.mentionHandler({
                discordMessageId: message.id,
                referencedMessageId: message.reference?.messageId ?? null,
                channelId: message.channelId,
                guildId: message.guildId,
                userContent,
                attachments,
                onStatusUpdate,
                attachmentRefetcher,
            });

            // Cancel any pending status edit before writing the final response
            this.statusUpdater.cancel(thinkingMessage.id);

            // Truncate to Discord's 2000-character limit
            const safeResponse =
                response.length > 2000
                    ? `${response.slice(0, 1997)}...`
                    : response;

            // Replace the placeholder with the final response
            await thinkingMessage.edit(safeResponse);

            // Persist only after the final response is successfully displayed
            await this.botReplySaved({
                botDiscordMessageId: thinkingMessage.id,
                repliesToDiscordId: message.id,
                channelId: thinkingMessage.channelId,
                guildId: thinkingMessage.guildId,
                newMessages,
            });
        } catch (err) {
            this.logger.error(
                { err, discordMessageId: message.id },
                "Failed to process mention",
            );

            this.statusUpdater.cancel(thinkingMessage.id);

            try {
                await thinkingMessage.edit(
                    "Sorry, I encountered an error processing your request.",
                );
            } catch (editErr) {
                throw new DiscordError("Failed to send error reply", editErr);
            }
        }
    }
}
