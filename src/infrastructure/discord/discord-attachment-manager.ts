import type { Client } from 'discord.js';
import type { IAttachmentManager } from '../../core/application/interfaces/attachment-manager';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import type { DiscordAttachment, DiscordAttachmentSourceMetadata, Metadata } from '../../core/domain/entities/message';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import { assertTextBasedChannel } from './discord-utils';

export class DiscordAttachmentManager<TPersistence extends Metadata = Metadata>
	implements IAttachmentManager<DiscordAttachmentSourceMetadata, TPersistence>
{
	constructor(
		private readonly client: Client,
		private readonly chatRepo: IChatRepository,
		private readonly logger: ILogger,
	) {}

	async getAttachmentStream(
		attachment: DiscordAttachment<TPersistence>,
		messageId: string,
	): Promise<{
		stream: ReadableStream;
		mimeType: string;
		contentLength?: number;
	}> {
		const url = attachment.url;

		if (!url) {
			throw new Error(`Attachment ${attachment.id} has no URL`);
		}

		// 1. Try fetching the URL directly
		let response = await fetch(url);

		const channelId = attachment.sourceMetadata.channelId;
		const discordMessageId = attachment.sourceMetadata.discordMessageId;

		// 2. If it fails (likely 403/404 due to expiration), try to refresh it via Discord
		if (!response.ok && attachment.id && channelId && discordMessageId) {
			this.logger.warn(
				`Failed to fetch attachment ${attachment.id} from ${url}. status=${response.status}. Attempting to refresh via Discord API...`,
			);

			try {
				// 1. Fetch Channel
				const channel = await this.client.channels.fetch(channelId);
				const textChannel = assertTextBasedChannel(channel, channelId);

				// 2. Fetch Message
				const message = await textChannel.messages.fetch(discordMessageId);

				if (!message) {
					throw new Error(`Message ${discordMessageId} not found`);
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
						url: freshAttachment.url,
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
			throw new Error('Response body is empty');
		}

		return {
			stream: response.body,
			mimeType,
			contentLength,
		};
	}

	async updateAttachmentMetadata(
		messageId: string,
		attachmentId: string,
		metadata: Partial<DiscordAttachment<TPersistence>>,
	): Promise<void> {
		await this.chatRepo.updateAttachment(messageId, attachmentId, metadata);
	}
}
