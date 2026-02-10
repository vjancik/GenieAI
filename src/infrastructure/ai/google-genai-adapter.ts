import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type Content, GoogleGenAI, type Part } from '@google/genai/node';
import type { IAttachmentManager } from '../../core/application/interfaces/attachment-manager';
import type {
	AttachmentUpdate,
	GenerationResult,
	IGenerativeAIModel,
} from '../../core/application/interfaces/illm-provider';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import type {
	GenAIAttachmentPersistenceMetadata,
	Message,
	MessageAttachment,
	Metadata,
} from '../../core/domain/entities/message';
import { AIProviderError } from '../../core/domain/errors/application-error';
import { Role } from '../../core/domain/value-objects/role';
import { GenAIFileService } from './genai-file-service';
import { StreamingBufferService } from './streaming-buffer-service';

export class GoogleGenAIAdapter implements IGenerativeAIModel<GenAIAttachmentPersistenceMetadata> {
	private readonly client: GoogleGenAI;
	private readonly model: string;
	private readonly systemPrompt: string;
	private readonly fileService: GenAIFileService;
	private readonly bufferService: StreamingBufferService;

	private static readonly UPLOAD_CONCURRENCY_LIMIT = 10;
	private static activeUploads = 0;
	private static uploadWaiters: (() => void)[] = [];

	private readonly maxRetries = 3;

	constructor(
		private readonly attachmentManager: IAttachmentManager,
		private readonly logger: ILogger,
		config: { apiKey: string; model: string; systemPrompt: string },
	) {
		this.client = new GoogleGenAI({ apiKey: config.apiKey, apiVersion: 'v1beta' });
		this.model = config.model;
		this.systemPrompt = config.systemPrompt;
		this.fileService = new GenAIFileService(this.client, logger);
		this.bufferService = new StreamingBufferService(join(tmpdir(), 'genie-ai-bot'), logger);
	}

	async generateContent(history: Message[]): Promise<GenerationResult<GenAIAttachmentPersistenceMetadata>> {
		const attachmentUpdates: AttachmentUpdate<GenAIAttachmentPersistenceMetadata>[] = [];
		const pastHistoryMessages = history.slice(0, -1);
		const lastMessage = history[history.length - 1];

		if (!lastMessage) {
			throw new AIProviderError('Cannot generate content from empty history');
		}

		const googleHistory = await Promise.all(
			pastHistoryMessages.map(async (msg) => {
				const { content, updates } = await this.mapMessageToContent(msg);
				attachmentUpdates.push(...updates);
				return content;
			}),
		);

		const chat = this.client.chats.create({
			model: this.model,
			config: { systemInstruction: this.systemPrompt },
			history: googleHistory,
		});

		const { content: lastContent, updates: lastUpdates } = await this.mapMessageToContent(lastMessage);
		attachmentUpdates.push(...lastUpdates);

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const result = await chat.sendMessage({
					message: lastContent.parts || [],
				});

				const responseText = result.text;
				if (!responseText) {
					throw new AIProviderError('Empty response from AI model');
				}

				return {
					content: responseText,
					attachmentUpdates: attachmentUpdates.length > 0 ? attachmentUpdates : undefined,
				};
			} catch (error) {
				const is503 = error instanceof ApiError && error.status === 503;
				const isEmptyResponse = error instanceof AIProviderError && error.message === 'Empty response from AI model';

				if ((is503 || isEmptyResponse) && attempt < this.maxRetries) {
					this.logger.warn(
						`Retryable error (attempt ${attempt + 1}/${
							this.maxRetries
						}) due to ${is503 ? '503 Service Unavailable' : 'empty response'}. Retrying in ${2 ** attempt}s...`,
					);
					await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
					continue;
				}

				if (error instanceof AIProviderError) throw error;
				throw new AIProviderError('Failed to generate content with Google GenAI', error);
			}
		}
		// Technically unreachable due to throw in catch on last attempt
		throw new AIProviderError('Max retries exceeded');
	}

	private async mapMessageToContent(msg: Message): Promise<{ content: Content; updates: AttachmentUpdate[] }> {
		// We format each message to include author name and dynamic labels,
		// but keep them as separate turns for the LLM.
		const { text } = msg.formatForAI({
			authorName: (msg.metadata.authorName as string) || undefined,
		});

		const parts: Content['parts'] = [{ text }];
		const updates: AttachmentUpdate[] = [];

		if (msg.attachments?.length) {
			const attachmentParts = await Promise.all(
				msg.attachments.map(async (att) => {
					const result = await this.resolveAttachmentPart(att, msg.id);
					if (result.update) updates.push(result.update);
					return result.part;
				}),
			);
			for (const part of attachmentParts) {
				if (part) {
					parts.push(part);
				}
			}
		}

		return {
			content: {
				role: this.mapRole(msg.role),
				parts: parts,
			},
			updates,
		};
	}

	private async resolveAttachmentPart<TSource extends Metadata = Metadata>(
		attachment: MessageAttachment<TSource, GenAIAttachmentPersistenceMetadata>,
		messageId: string,
	): Promise<{ part: Part | null; update?: AttachmentUpdate<GenAIAttachmentPersistenceMetadata> }> {
		try {
			const persistence = attachment.persistenceMetadata;
			const genaiExpirationTime = persistence.genaiExpirationTime
				? new Date(persistence.genaiExpirationTime)
				: undefined;

			if (persistence.genaiUri && genaiExpirationTime && genaiExpirationTime > new Date()) {
				return { part: { fileData: { fileUri: persistence.genaiUri, mimeType: attachment.mimeType } } };
			}

			if (attachment.url) {
				const fileMetadata = await this.uploadFile(attachment, messageId);
				if (fileMetadata) {
					const update: AttachmentUpdate = {
						messageId,
						attachmentId: attachment.id || '',
						persistenceMetadata: {
							...persistence,
							genaiUri: fileMetadata.uri,
							genaiExpirationTime: fileMetadata.expirationTime ? new Date(fileMetadata.expirationTime) : undefined,
						},
					};

					return {
						part: { fileData: { fileUri: fileMetadata.uri, mimeType: attachment.mimeType } },
						update,
					};
				}
			}

			if (attachment.data) {
				return { part: { inlineData: { mimeType: attachment.mimeType, data: attachment.data } } };
			}
		} catch (error) {
			this.logger.error('Error resolving attachment:', error);
		}

		return { part: null };
	}

	private async uploadFile(attachment: MessageAttachment, messageId: string) {
		await this.acquireUploadLock();
		try {
			const { stream } = await this.attachmentManager.getAttachmentStream(attachment, messageId);

			const { buffer, filePath } = await this.bufferService.readStreamWithTwoTierLimits(
				stream as ReadableStream<Uint8Array>,
				20 * 1024 * 1024,
				100 * 1024 * 1024,
			);

			try {
				const uploadInput = buffer ? new Blob([buffer]) : (filePath as string);

				const uploadResult = await this.fileService.uploadDirect(uploadInput, {
					mimeType: attachment.mimeType,
					displayName: attachment.name,
				});

				this.releaseUploadLock();

				return await this.fileService.waitForFileProcessing(uploadResult);
			} finally {
				if (filePath) {
					await unlink(filePath).catch(() => {});
				}
			}
		} catch (error) {
			this.releaseUploadLock();
			throw error;
		}
	}

	private async acquireUploadLock() {
		if (GoogleGenAIAdapter.activeUploads < GoogleGenAIAdapter.UPLOAD_CONCURRENCY_LIMIT) {
			GoogleGenAIAdapter.activeUploads++;
			return;
		}
		return new Promise<void>((resolve) => {
			GoogleGenAIAdapter.uploadWaiters.push(resolve);
		});
	}

	private releaseUploadLock() {
		const waiter = GoogleGenAIAdapter.uploadWaiters.shift();
		if (waiter) {
			waiter();
		} else {
			GoogleGenAIAdapter.activeUploads--;
		}
	}

	private mapRole(role: Role): string {
		switch (role) {
			case Role.USER:
				return 'user';
			case Role.ASSISTANT:
				return 'model';
			default:
				return 'user';
		}
	}
}
