import {
    Client,
    Events,
    GatewayIntentBits,
    type Message,
} from "discord.js";
import { DiscordError } from "../../domain/errors/AppError.ts";
import type { Logger } from "../logging/logger.ts";

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
    return message.content
        .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
        // TODO: pass the bot default server role ID to selectively strip only the bot's role mention, if present
        .replace(/<@&\d+>/g, "")
        .trim();
}

/** Callback invoked when the bot receives a valid explicit mention. */
export type MentionHandler = (params: {
    discordMessageId: string;
    referencedMessageId: string | null;
    channelId: string;
    guildId: string | null;
    userContent: string;
}) => Promise<string>;

/** Callback invoked after the bot's reply is sent, to persist the bot's message. */
export type BotReplySavedCallback = (params: {
    botDiscordMessageId: string;
    repliesToDiscordId: string;
    channelId: string;
    guildId: string | null;
    response: string;
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
        if (!userContent) {
            await message.reply("Hi! Mention me with a question or a request.");
            return;
        }

        this.logger.info(
            {
                discordMessageId: message.id,
                channelId: message.channelId,
                referencedMessageId: message.reference?.messageId ?? null,
            },
            "Processing bot mention",
        );

        try {
            const response = await this.mentionHandler({
                discordMessageId: message.id,
                referencedMessageId: message.reference?.messageId ?? null,
                channelId: message.channelId,
                guildId: message.guildId,
                userContent,
            });

            // Send the reply and get the sent message's Discord ID for persistence
            const sentMessage = await message.reply(response);

            await this.botReplySaved({
                botDiscordMessageId: sentMessage.id,
                repliesToDiscordId: message.id,
                channelId: sentMessage.channelId,
                guildId: sentMessage.guildId,
                response,
            });
        } catch (err) {
            this.logger.error(
                { err, discordMessageId: message.id },
                "Failed to process mention",
            );
            try {
                await message.reply(
                    "Sorry, I encountered an error processing your request.",
                );
            } catch (replyErr) {
                throw new DiscordError("Failed to send error reply", replyErr);
            }
        }
    }
}
