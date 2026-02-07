
import { Client, TextChannel } from 'discord.js';
import type { IAttachmentManager } from '../../core/application/interfaces/attachment-manager';
import type { MessageAttachment } from '../../core/domain/entities/message';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { ILogger } from '../../core/application/interfaces/logger.interface';

export class DiscordAttachmentManager implements IAttachmentManager {
    constructor(
        private readonly client: Client,
        private readonly chatRepo: IChatRepository,
        private readonly logger: ILogger
    ) { }

    async getAttachmentStream(attachment: MessageAttachment, messageId: string): Promise<{
        stream: ReadableStream;
        mimeType: string;
        contentLength?: number;
    }> {
        let url = attachment.url;

        if (!url) {
            throw new Error(`Attachment ${attachment.id} has no URL`);
        }

        // 1. Try fetching the URL directly
        let response = await fetch(url);

        // 2. If it fails (likely 403/404 due to expiration), try to refresh it via Discord
        if (!response.ok && attachment.id && attachment.channelId && attachment.discordMessageId) {
            this.logger.warn(`Failed to fetch attachment ${attachment.id} from ${url}. status=${response.status}. Attempting to refresh via Discord API...`);

            try {
                // 1. Fetch Channel
                const channel = await this.client.channels.fetch(attachment.channelId);

                if (!channel || !channel.isTextBased()) {
                    throw new Error(`Channel ${attachment.channelId} not found or not text-based`);
                }

                // 2. Fetch Message
                // Type assertion as 'any' because strict typing on channels.fetch union return is difficult without guards, 
                // but isTextBased() generally implies messages.fetch exists.
                // Better: cast to TextChannel if possible, or use (channel as any).messages
                const textChannel = channel as TextChannel;
                const message = await textChannel.messages.fetch(attachment.discordMessageId);

                if (!message) {
                    throw new Error(`Message ${attachment.discordMessageId} not found`);
                }

                // 3. Find Attachment
                const freshAttachment = message.attachments.get(attachment.id);
                if (!freshAttachment) {
                    throw new Error(`Attachment ${attachment.id} not found on message`);
                }

                this.logger.info(`Refreshed attachment URL: ${freshAttachment.url}`);

                // 4. Retry Fetch
                response = await fetch(freshAttachment.url);

                if (!response.ok) {
                    throw new Error(`Refreshed URL fetch failed: ${response.status} ${response.statusText}`);
                }

                // 5. Persist Refreshed URL
                // We update the database so future fetches don't need to hit Discord API again until this expires.
                try {
                    await this.updateAttachmentMetadata(messageId, attachment.id, {
                        url: freshAttachment.url
                    });
                    this.logger.info(`Persisted fresh URL for attachment ${attachment.id}`);
                } catch (persistError) {
                    this.logger.error(`Failed to persist refreshed URL for attachment ${attachment.id}`, persistError);
                    // Continue, as we have the stream.
                }

            } catch (error) {
                this.logger.error(`Error refreshing attachment ${attachment.id}:`, error);
                throw error;
            }
        } else if (!response.ok) {
            throw new Error(`Attachment file fetch failed: ${response.status} ${response.statusText}`);
        }

        const mimeType = response.headers.get('content-type') || attachment.mimeType;
        const lengthStr = response.headers.get('content-length');
        const contentLength = lengthStr ? parseInt(lengthStr, 10) : undefined;

        if (!response.body) {
            throw new Error("Response body is empty");
        }

        return {
            stream: response.body,
            mimeType,
            contentLength
        };
    }

    async updateAttachmentMetadata(messageId: string, attachmentId: string, metadata: Partial<MessageAttachment>): Promise<void> {
        await this.chatRepo.updateAttachment(messageId, attachmentId, metadata);
    }
}
