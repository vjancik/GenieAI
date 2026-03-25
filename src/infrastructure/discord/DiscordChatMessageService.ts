import type { Client, Message, TextBasedChannel } from "discord.js";
import type { FileConfig } from "../../application/config/AppConfig.ts";
import type { IChatClientMessage } from "../../application/ports/chat/IChatClient.ts";
import type { IChatMessageService } from "../../application/ports/IChatMessageService.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { DiscordClientMessage } from "./adapters/DiscordClientMessage.ts";
import type { DiscordClient } from "./DiscordClient.ts";

/**
 * Discord-backed implementation of {@link IChatMessageService}.
 *
 * Walks the Discord reply chain upward from a given message ID by repeatedly
 * fetching the parent message via the Discord API. Used as a fallback when the
 * DB reply chain is empty (e.g. pre-existing conversations or after a DB wipe).
 *
 * Returns {@link IChatClientMessage} objects — the application-layer abstraction
 * over discord.js `Message` — so that discord.js types do not leak further up.
 */
export class DiscordChatMessageService implements IChatMessageService {
    /** Saved reference to the discord.js Client, available after DiscordClient.start(). */
    private readonly client: Client;
    private readonly chainLimit: number;

    constructor(
        discordClient: DiscordClient,
        private readonly logger: Logger,
        config: Pick<FileConfig, "discord">,
    ) {
        this.client = discordClient.client;
        this.chainLimit = config.discord.chainLimit;
    }

    async fetchChain(lookup: {
        startDiscordMessageId: string;
        channelId: string;
        guildId: string;
        limit?: number;
    }): Promise<IChatClientMessage[]> {
        const limit = lookup.limit ?? this.chainLimit;
        const chain: IChatClientMessage[] = [];

        const channel = await this.fetchTextChannel(lookup.channelId);
        if (channel === null) return [];

        let currentMessageId: string | null = lookup.startDiscordMessageId;

        while (currentMessageId !== null && chain.length < limit) {
            try {
                const rawMessage: Message = await channel.messages.fetch(currentMessageId);
                const message = new DiscordClientMessage(rawMessage);

                // Prepend so we accumulate root-first
                chain.unshift(message);
                // We treat forwards as chain roots — their referencedMessageId points to the source, not a reply parent
                currentMessageId = message.isForwarded ? null : message.referencedMessageId;
            } catch (err) {
                // Stop traversal on any fetch failure; return what was collected
                this.logger.warn(
                    { err, messageId: currentMessageId, channelId: lookup.channelId },
                    "Failed to fetch message during live chain walk — returning partial chain",
                );
                break;
            }
        }

        this.logger.debug(
            { startMessageId: lookup.startDiscordMessageId, chainLength: chain.length },
            "Fetched live Discord message chain",
        );

        return chain;
    }

    /** Fetches and validates that the channel is text-based. Returns null on failure or non-text channel. */
    private async fetchTextChannel(channelId: string): Promise<TextBasedChannel | null> {
        try {
            const fetched = await this.client.channels.fetch(channelId);
            if (!fetched?.isTextBased()) {
                this.logger.debug({ channelId }, "Channel not found or not text-based — live chain fetch skipped");
                return null;
            }
            return fetched;
        } catch (err) {
            this.logger.warn({ err, channelId }, "Failed to fetch channel for live chain fetch");
            return null;
        }
    }
}
