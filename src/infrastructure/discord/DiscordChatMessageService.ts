import type { Client, Message, TextBasedChannel } from "discord.js";
import type { FileConfig } from "../../application/config/AppConfig.ts";
import type { DiscordMessageSnapshot, IChatMessageService } from "../../application/ports/IChatMessageService.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { DiscordClientMessage } from "./chat/DiscordClientMessage.ts";
import type { DiscordClient } from "./DiscordClient.ts";
import { buildSnapshot } from "./messageExtractors.ts";

/**
 * Discord-backed implementation of {@link IChatMessageService}.
 *
 * Walks the Discord reply chain upward from a given message ID by repeatedly
 * fetching the parent message via the Discord API. Used as a fallback when the
 * DB reply chain is empty (e.g. pre-existing conversations or after a DB wipe).
 *
 * Consumers of this service receive {@link DiscordMessageSnapshot} values —
 * a typed subset of the full discord.js Message type — so that discord.js
 * types do not leak into the application layer.
 */
export class DiscordChatMessageService implements IChatMessageService {
    /** Saved reference to the discord.js Client, available after DiscordClient.start(). */
    private readonly client: Client;
    private readonly defaultChainLimit: number;

    constructor(
        discordClient: DiscordClient,
        /** Optional Discord user ID of a previous bot version treated as own-bot messages. */
        private readonly previousBotId: string | undefined,
        private readonly logger: Logger,
        config: Pick<FileConfig, "discord">,
    ) {
        this.client = discordClient.client;
        this.defaultChainLimit = config.discord.defaultChainLimit;
    }

    async fetchChain(lookup: {
        startDiscordMessageId: string;
        channelId: string;
        guildId: string;
        limit?: number;
    }): Promise<DiscordMessageSnapshot[]> {
        const limit = lookup.limit ?? this.defaultChainLimit;
        const chain: DiscordMessageSnapshot[] = [];

        const channel = await this.fetchTextChannel(lookup.channelId);
        if (channel === null) return [];

        const botUserId = this.client.user?.id;
        let currentMessageId: string | null = lookup.startDiscordMessageId;

        while (currentMessageId !== null && chain.length < limit) {
            try {
                const rawMessage: Message = await channel.messages.fetch(currentMessageId);
                const snapshot = buildSnapshot(new DiscordClientMessage(rawMessage), botUserId, this.previousBotId);

                // Prepend so we accumulate root-first
                chain.unshift(snapshot);
                // For forwarded messages buildSnapshot sets referencedMessageId to null,
                // which naturally terminates the traversal here
                currentMessageId = snapshot.referencedMessageId;
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
