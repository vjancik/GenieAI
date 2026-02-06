import { v4 as uuidv4 } from "uuid";
import { Message, type MessageAttachment } from '../../domain/entities/message';
import type { IChatRepository } from '../../domain/repositories/chat-repository';
import { Role } from '../../domain/value-objects/role';
import type { IGenerativeAIModel } from '../interfaces/illm-provider';

import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';

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
        private readonly logger: ILogger
    ) { }

    async execute(dto: SendMessageDTO): Promise<Message> {
        return tracer.startActiveSpan('SendMessageUseCase.execute', async (span) => {
            try {
                span.setAttribute('conversation_id', dto.conversationId);
                if (dto.userId) span.setAttribute('user_id', dto.userId);

                // 1. Create and Save User Message
                const userMessage = new Message({
                    id: dto.id || uuidv4(),
                    role: Role.USER,
                    content: dto.content,
                    timestamp: new Date(),
                    metadata: { userId: dto.userId },
                    parentId: dto.parentId,
                    attachments: dto.attachments
                });

                await this.chatRepo.saveMessage(userMessage, dto.externalId);

                // 2. Load History
                let history: Message[];
                if (dto.history) {
                    history = [...dto.history, userMessage];
                } else {
                    history = dto.parentId
                        ? [...(await this.chatRepo.getHistory(dto.parentId)), userMessage]
                        : [userMessage];
                }

                // 3. Generate AI Response
                span.addEvent('Generating AI response');
                const startTime = performance.now();
                const aiResponseText = await this.aiModel.generateContent(history, dto.content);
                const duration = performance.now() - startTime;
                span.addEvent('AI response generated');

                // Record Metric
                generationTimeHistogram.record(duration, {
                    'ai.model': 'google-genai',
                });

                // Track in span and log
                span.setAttribute('ai.response_length', aiResponseText.length);
                span.setAttribute('ai.duration_ms', duration);
                span.setAttribute('ai.response_preview', aiResponseText.substring(0, 100) + '...');

                this.logger.info('AI Response generated', {
                    conversationId: dto.conversationId,
                    response: aiResponseText,
                    durationMs: duration
                });

                // 4. Create and Save AI Message
                const aiMessage = new Message({
                    id: uuidv4(),
                    role: Role.ASSISTANT,
                    content: aiResponseText,
                    timestamp: new Date(),
                    parentId: userMessage.id
                });

                await this.chatRepo.saveMessage(aiMessage);

                span.setStatus({ code: SpanStatusCode.OK });
                return aiMessage;
            } catch (error) {
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error)
                });
                span.recordException(error as Error);
                throw error;
            } finally {
                span.end();
            }
        });
    }
}
