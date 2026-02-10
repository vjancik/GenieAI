import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { Conversation } from '../../domain/entities/conversation';
import { BaseMessage, type Message, type MessageAttachment } from '../../domain/entities/message';
import type { IChatRepository } from '../../domain/repositories/chat-repository';
import type { HistoryService } from '../../domain/services/history-service';
import { Role } from '../../domain/value-objects/role';
import type { IIdentityGenerator } from '../interfaces/identity-generator.interface';
import type { IGenerativeAIModel } from '../interfaces/illm-provider';

const tracer = trace.getTracer('genie-ai-bot');
const meter = metrics.getMeter('genie-ai-bot');

const generationTimeHistogram = meter.createHistogram('ai.generation_time', {
	description: 'Time taken to generate AI content',
	unit: 'ms',
});

export interface SendMessageDTO {
	conversationId: string;
	content: string;
	userId?: string;
	history?: Message[];
	id?: string;
	parentId?: string;
	attachments?: MessageAttachment[];
	externalId?: string;
}

import type { ILogger } from '../interfaces/logger.interface';

export class SendMessageUseCase {
	constructor(
		private readonly chatRepo: IChatRepository,
		private readonly aiModel: IGenerativeAIModel,
		private readonly historyService: HistoryService,
		private readonly idGenerator: IIdentityGenerator,
		private readonly logger: ILogger,
	) {}

	async execute(dto: SendMessageDTO): Promise<Message> {
		return tracer.startActiveSpan('SendMessageUseCase.execute', async (span) => {
			try {
				span.setAttribute('conversation_id', dto.conversationId);
				if (dto.userId) span.setAttribute('user_id', dto.userId);

				// 1. Create and Save User Message
				const userMessage = new BaseMessage({
					id: dto.id ?? this.idGenerator.generate(),
					role: Role.USER,
					content: dto.content,
					timestamp: new Date(),
					metadata: { userId: dto.userId },
					parentId: dto.parentId,
					attachments: dto.attachments,
				});

				await this.chatRepo.saveMessage(userMessage, dto.externalId);

				// 2. Load and Manage History via Domain Services
				let conversation: Conversation;

				if (dto.history && dto.history.length > 0) {
					// Use provided history
					conversation = new Conversation({
						id: dto.conversationId,
						messages: [...dto.history],
					});
					conversation.addMessage(userMessage);
				} else if (dto.parentId) {
					// Fetch history from parent
					conversation = await this.historyService.getConversation(dto.parentId);
					conversation.addMessage(userMessage);
				} else {
					// New conversation
					conversation = await this.historyService.createConversation(userMessage);
				}

				// 3. Generate AI Response using Domain context
				span.addEvent('Generating AI response');
				const startTime = performance.now();

				// We pass history as messages to the model, which allows it to leverage structured turns and caching.
				const result = await this.aiModel.generateContent(conversation.getTranscript());
				const aiResponseText = result.content;

				const duration = performance.now() - startTime;
				span.addEvent('AI response generated');

				// 3b. Handle Attachment Updates
				if (result.attachmentUpdates) {
					for (const update of result.attachmentUpdates) {
						await this.chatRepo.updateAttachment(update.messageId, update.attachmentId, {
							persistenceMetadata: update.persistenceMetadata,
						});
					}
				}

				// Record Metric
				generationTimeHistogram.record(duration, {
					'ai.model': 'google-genai',
				});

				// Track in span and log
				span.setAttribute('ai.response_length', aiResponseText.length);
				span.setAttribute('ai.duration_ms', duration);
				span.setAttribute('ai.response_preview', `${aiResponseText.substring(0, 100)}...`);

				this.logger.info('AI Response generated', {
					conversationId: dto.conversationId,
					response: aiResponseText,
					durationMs: duration,
				});

				// 4. Create and Save AI Message
				const aiMessage = new BaseMessage({
					id: this.idGenerator.generate(),
					role: Role.ASSISTANT,
					content: aiResponseText,
					timestamp: new Date(),
					parentId: userMessage.id,
				});

				await this.chatRepo.saveMessage(aiMessage);

				span.setStatus({ code: SpanStatusCode.OK });
				return aiMessage;
			} catch (error) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span.recordException(error as Error);
				throw error;
			} finally {
				span.end();
			}
		});
	}
}
