import { GoogleGenAI, type Content } from '@google/genai';
import type { IGenerativeAIModel } from '../../core/application/interfaces/illm-provider';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';
import { Role } from '../../core/domain/value-objects/role';
import { config } from '../../config/env';

import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { AIProviderError } from '../../core/domain/errors/application-error';
import { GoogleGenAIFileUploader } from './google-genai-file-uploader';

export class GoogleGenAIAdapter implements IGenerativeAIModel {
    private client: GoogleGenAI;
    private model: string;
    private systemPrompt: string;

    private logger: ILogger;
    private fileUploader: GoogleGenAIFileUploader;

    private static fallbackQueue: Promise<void> = Promise.resolve();
    private readonly MAX_FALLBACK_SIZE = 20 * 1024 * 1024; // 20MB limit for memory fallback

    constructor(
        private readonly chatRepo: IChatRepository,
        logger: ILogger
    ) {
        this.logger = logger.child({ className: 'GoogleGenAIAdapter' });
        this.client = new GoogleGenAI({ apiKey: config.ai.apiKey });
        this.model = config.ai.model;
        this.systemPrompt = config.ai.systemPrompt;
        this.fileUploader = new GoogleGenAIFileUploader(this.client, this.logger);
    }

    async generateContent(history: Message[], prompt: string): Promise<string> {
        try {
            // The 'history' array includes the latest user message at the end.
            // We need to separate it because 'sendMessage' takes the new message,
            // and 'history' in 'chats.create' is strictly past history.

            // Exclude the last message (which is the current prompt)
            const pastHistoryMessages = history.slice(0, -1);
            const currentMessage = history[history.length - 1];

            // Process past history concurrently
            const googleHistory = await Promise.all(pastHistoryMessages.map(msg => this.mapMessageToContent(msg)));

            const chat = this.client.chats.create({
                model: this.model,
                config: {
                    systemInstruction: this.systemPrompt,
                },
                history: googleHistory
            });

            const currentParts: Content['parts'] = [{ text: prompt }];
            if (currentMessage?.attachments?.length) {
                for (const attachment of currentMessage.attachments) {
                    const part = await this.resolveAttachmentPart(attachment, currentMessage.id);
                    if (part) {
                        currentParts.push(part);
                    }
                }
            }

            const result = await chat.sendMessage({
                message: currentParts
            });

            const responseText = result.text;
            if (!responseText) {
                throw new AIProviderError('Empty response from AI model');
            }

            return responseText;
        } catch (error) {
            if (error instanceof AIProviderError) throw error;
            throw new AIProviderError('Failed to generate content with Google GenAI', error);
        }
    }

    private async mapMessageToContent(msg: Message): Promise<Content> {
        const parts: Content['parts'] = [{ text: msg.content }];

        if (msg.attachments?.length) {
            for (const attachment of msg.attachments) {
                const part = await this.resolveAttachmentPart(attachment, msg.id);
                if (part) {
                    parts.push(part);
                }
            }
        }

        return {
            role: this.mapRole(msg.role),
            parts: parts
        };
    }

    private async resolveAttachmentPart(attachment: MessageAttachment, messageId: string) {
        try {
            // Check if we have a valid GenAI URI
            if (attachment.genaiUri && attachment.genaiExpirationTime && new Date(attachment.genaiExpirationTime) > new Date()) {
                return { fileData: { fileUri: attachment.genaiUri, mimeType: attachment.mimeType } };
            }

            // If not, and we have a URL, upload it
            if (attachment.url) {
                const fileMetadata = await this.uploadFile(attachment);
                if (fileMetadata) {
                    // Update our internal/in-memory reference
                    attachment.genaiUri = fileMetadata.uri;
                    if (fileMetadata.expirationTime) {
                        attachment.genaiExpirationTime = new Date(fileMetadata.expirationTime);
                    }

                    // Persist Update via Repository
                    if (attachment.id) {
                        try {
                            await this.chatRepo.updateAttachment(messageId, attachment.id, {
                                genaiUri: attachment.genaiUri,
                                genaiExpirationTime: attachment.genaiExpirationTime
                            });
                        } catch (err) {
                            this.logger.error("Failed to update attachment metadata in repo", err);
                        }
                    }

                    return { fileData: { fileUri: attachment.genaiUri, mimeType: attachment.mimeType } };
                }
            }

            // Fallback to inline data if available
            if (attachment.data) {
                return { inlineData: { mimeType: attachment.mimeType, data: attachment.data } };
            }
        } catch (error) {
            this.logger.error("Error resolving attachment:", error);
        }

        return null;
    }

    private async uploadFile(attachment: MessageAttachment) {
        if (!attachment.url) return null;
        let releaseLock: (() => void) | undefined;

        try {
            this.logger.info(`Streaming file from ${attachment.url} to Google GenAI...`);
            const response = await fetch(attachment.url);
            if (!response.ok) {
                throw new AIProviderError(`Failed to fetch attachment from ${attachment.url}`);
            }

            const size = parseInt(response.headers.get('content-length') || '0', 10);
            const stream = response.body;

            if (!stream) {
                throw new AIProviderError(`Failed to get readable stream for attachment ${attachment.url}`);
            }

            if (!size) {
                // Acquire exclusive access for memory-intensive fallback upload
                const currentQueue = GoogleGenAIAdapter.fallbackQueue;
                let resolve: (() => void) | undefined;
                GoogleGenAIAdapter.fallbackQueue = new Promise(r => resolve = r);

                this.logger.warn(`Attachment ${attachment.url} has no content-length. Waiting for exclusive fallback lock...`);
                await currentQueue;
                releaseLock = resolve;

                this.logger.info(`Locked fallback upload. Downloading with ${this.MAX_FALLBACK_SIZE / 1024 / 1024}MB limit...`);

                const buffer = await this.readStreamWithLimit(stream, this.MAX_FALLBACK_SIZE);
                const blob = new Blob([buffer], { type: attachment.mimeType });

                const uploadResponse = await this.client.files.upload({
                    file: blob, // Blob is compatible with the SDK's expected input
                    config: {
                        mimeType: attachment.mimeType,
                    }
                });
                return uploadResponse;
            }

            const uploadResponse = await this.fileUploader.uploadStream(stream, {
                mimeType: attachment.mimeType,
                size: size,
                displayName: attachment.name || undefined
            });

            this.logger.info(`File streamed and uploaded: ${uploadResponse.uri}`);
            return uploadResponse;
        } catch (error) {
            throw new AIProviderError(`Failed to stream upload file to Google GenAI: ${attachment.url}`, error);
        } finally {
            if (releaseLock) {
                this.logger.debug("Releasing fallback upload lock.");
                releaseLock();
            }
        }
    }

    private async readStreamWithLimit(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        const reader = stream.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                totalSize += value.length;
                if (totalSize > limit) {
                    await reader.cancel();
                    throw new AIProviderError(`File too large: exceeds ${limit / 1024 / 1024}MB limit for attachments without content-length metadata.`);
                }
                chunks.push(value);
            }
            return Buffer.concat(chunks);
        } finally {
            reader.releaseLock();
        }
    }

    private mapRole(role: Role): string {
        switch (role) {
            case Role.USER:
                return 'user';
            case Role.ASSISTANT:
                return 'model';
            case Role.SYSTEM:
                return 'user'; // System prompts are usually handled via config
            default:
                return 'user';
        }
    }
}
