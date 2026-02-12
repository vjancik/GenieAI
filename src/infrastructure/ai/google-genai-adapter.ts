import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ApiError,
	type Content,
	createModelContent,
	createPartFromBase64,
	createPartFromText,
	createPartFromUri,
	createUserContent,
	GoogleGenAI,
	type Part,
} from '@google/genai/node';
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

	private readonly maxRetries: number;

	private readonly attachmentMemoryLimit: number;
	private readonly attachmentDiskLimit: number;

	constructor(
		private readonly attachmentManager: IAttachmentManager,
		private readonly logger: ILogger,
		config: {
			apiKey: string;
			model: string;
			systemPrompt: string;
			attachmentMemoryLimit: number;
			attachmentDiskLimit: number;
			maxRetries: number;
		},
	) {
		this.client = new GoogleGenAI({ apiKey: config.apiKey });
		this.model = config.model;
		this.systemPrompt = config.systemPrompt;
		this.attachmentMemoryLimit = config.attachmentMemoryLimit;
		this.attachmentDiskLimit = config.attachmentDiskLimit;
		this.maxRetries = config.maxRetries;
		this.fileService = new GenAIFileService(this.client, logger);
		this.bufferService = new StreamingBufferService(join(tmpdir(), 'genie-ai-bot'), logger);
	}

	async generateContent(history: Message[]): Promise<GenerationResult<GenAIAttachmentPersistenceMetadata>> {
		const attachmentUpdates: AttachmentUpdate<GenAIAttachmentPersistenceMetadata>[] = [];
		if (history.length === 0) {
			throw new AIProviderError('Cannot generate content from empty history');
		}

		const googleHistory = await Promise.all(
			history.map(async (msg) => {
				const { content, updates } = await this.mapMessageToContent(msg);
				attachmentUpdates.push(...updates);
				return content;
			}),
		);

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const result = await this.client.models.generateContent({
					model: this.model,
					config: { systemInstruction: this.systemPrompt },
					contents: googleHistory,
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
				const isRetryable =
					(error instanceof ApiError && (error.status === 503 || error.status === 429)) ||
					(error instanceof AIProviderError && error.message === 'Empty response from AI model');

				if (isRetryable && attempt < this.maxRetries) {
					const statusText = error instanceof ApiError ? `HTTP ${error.status}` : 'empty response';
					this.logger.warn(
						`Retryable error (attempt ${attempt + 1}/${
							this.maxRetries
						}) due to ${statusText}. Retrying in ${2 ** attempt}s...`,
					);
					await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
					continue;
				}

				if (error instanceof ApiError) {
					switch (error.status) {
						case 404:
							throw new AIProviderError(`Model not found: ${this.model}. Please check your configuration.`, error);
						case 429:
							throw new AIProviderError('Rate limit exceeded for Google GenAI API. Max retries exhausted.', error);
						case 400:
							throw new AIProviderError(
								'Invalid request sent to Google GenAI API. This might be due to content policy (safety filters) or invalid parameters.',
								error,
							);
						case 401:
						case 403:
							throw new AIProviderError(
								'Authentication failed or permission denied with Google GenAI API. Please check your API key.',
								error,
							);
						case 503:
							throw new AIProviderError('Google GenAI service is unavailable. Max retries exhausted.', error);
					}
				}

				if (error instanceof AIProviderError) throw error;
				throw new AIProviderError('Failed to generate content with Google GenAI', error);
			}
		}
		// Technically unreachable due to throw in catch on last attempt
		throw new AIProviderError('Max retries exceeded');
	}

	private async mapMessageToContent(msg: Message): Promise<{ content: Content; updates: AttachmentUpdate[] }> {
		const { text } = msg.formatForAI();

		const parts = [createPartFromText(text)];
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
			content: msg.role === Role.ASSISTANT ? createModelContent(parts) : createUserContent(parts),
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
				return { part: createPartFromUri(persistence.genaiUri, attachment.mimeType) };
			}

			if (attachment.url) {
				const fileMetadata = await this.uploadFile(attachment, messageId);
				if (fileMetadata) {
					const update: AttachmentUpdate = {
						messageId,
						attachmentId: attachment.id ?? '',
						persistenceMetadata: {
							...persistence,
							genaiUri: fileMetadata.uri,
							genaiExpirationTime: fileMetadata.expirationTime ? new Date(fileMetadata.expirationTime) : undefined,
						},
					};

					if (!fileMetadata.uri) {
						throw new AIProviderError(`File uploaded but no URI returned for ${attachment.name}`);
					}

					return {
						part: createPartFromUri(fileMetadata.uri, attachment.mimeType),
						update,
					};
				}
			}

			if (attachment.data) {
				return { part: createPartFromBase64(attachment.data, attachment.mimeType) };
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
				stream,
				this.attachmentMemoryLimit,
				this.attachmentDiskLimit,
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
}
