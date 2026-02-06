import { GoogleGenAI, type Content } from '@google/genai';
import type { IGenerativeAIModel } from '../../core/application/interfaces/illm-provider';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';
import { Role } from '../../core/domain/value-objects/role';
import { config } from '../../config/env';

import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { ILogger } from '../../core/application/interfaces/logger.interface';

export class GoogleGenAIAdapter implements IGenerativeAIModel {
    private client: GoogleGenAI;
    private model: string;
    private systemPrompt: string;

    private logger: ILogger;

    constructor(
        private readonly chatRepo: IChatRepository,
        logger: ILogger
    ) {
        this.logger = logger.child({ className: 'GoogleGenAIAdapter' });
        this.client = new GoogleGenAI({ apiKey: config.ai.apiKey });
        this.model = config.ai.model;
        this.systemPrompt = config.ai.systemPrompt;
    }

    async generateContent(history: Message[], prompt: string): Promise<string> {
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

        return result.text || '';
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

        this.logger.info(`Uploading file from ${attachment.url} to Google GenAI...`);
        const response = await fetch(attachment.url);
        if (!response.ok) {
            throw new Error(`Failed to fetch attachment from ${attachment.url}`);
        }

        // We use response.blob() which is compatible with the SDK's expected input
        const blob = await response.blob();

        const uploadResponse = await this.client.files.upload({
            file: blob,
            config: {
                mimeType: attachment.mimeType,
            }
        });

        // uploadResponse is the File object directly in this version of the SDK
        this.logger.info(`File uploaded: ${uploadResponse.uri}`);
        return uploadResponse;
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
