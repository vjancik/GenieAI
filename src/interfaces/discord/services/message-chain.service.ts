import { Message as DiscordMessage, Client } from 'discord.js';
import { Message } from '../../../core/domain/entities/message';
import { Role } from '../../../core/domain/value-objects/role';

export class MessageChainService {
    constructor(private readonly client: Client) { }

    /**
     * Traverses the reply chain backwards to build the conversation history.
     * Returns messages in chronological order (oldest first), EXCLUDING the current message.
     */
    async getReplyChain(currentMessage: DiscordMessage, limit: number = 20): Promise<Message[]> {
        const chain: DiscordMessage[] = [];
        let ptr = currentMessage;

        // Traverse backwards
        for (let i = 0; i < limit; i++) {
            if (!ptr.reference || !ptr.reference.messageId) {
                break;
            }

            try {
                // Determine channel to fetch from (usually same channel, but API requires distinct fetch)
                const channelId = ptr.reference.channelId;
                const messageId = ptr.reference.messageId;

                // Optimization: If channel is same as current, use current channel object
                const channel = channelId === currentMessage.channelId
                    ? currentMessage.channel
                    : await this.client.channels.fetch(channelId);

                if (!channel || !('messages' in channel)) {
                    // Channel not found or text-based
                    break;
                }

                // Fetch parent message
                const parent = await channel.messages.fetch(messageId);
                chain.push(parent);
                ptr = parent;
            } catch (error) {
                console.warn('Failed to fetch parent message in chain:', error);
                break; // Stop chain on broken link (deleted message, etc)
            }
        }

        // Reverse to get chronological order (Oldest -> Newest)
        chain.reverse();

        // Map to Domain Entities
        return chain.map(msg => this.mapToDomain(msg));
    }

    private mapToDomain(discordMsg: DiscordMessage): Message {
        const isBot = discordMsg.author.id === this.client.user?.id;

        return new Message({
            id: discordMsg.id, // Use Discord ID as Domain ID ensuring consistency
            role: isBot ? Role.ASSISTANT : Role.USER,
            content: discordMsg.content,
            timestamp: discordMsg.createdAt,
            metadata: {
                discordChannelId: discordMsg.channelId,
                discordAuthorId: discordMsg.author.id
            },
            parentId: discordMsg.reference?.messageId
        });
    }
}
