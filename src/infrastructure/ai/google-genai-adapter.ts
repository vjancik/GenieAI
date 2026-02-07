import { GoogleGenAI, type Content } from '@google/genai';
import type { IGenerativeAIModel } from '../../core/application/interfaces/illm-provider';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';
import { Role } from '../../core/domain/value-objects/role';
import { config } from '../../config/env';

import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { AIProviderError } from '../../core/domain/errors/application-error';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, readdir, unlink, open, type FileHandle } from 'fs/promises';
import { GoogleGenAIFileUploader } from './google-genai-file-uploader';

export class GoogleGenAIAdapter implements IGenerativeAIModel {
    private client: GoogleGenAI;
    private model: string;
    private systemPrompt: string;

    private logger: ILogger;
    private fileUploader: GoogleGenAIFileUploader;

    private static fallbackQueue: Promise<void> = Promise.resolve();
    private static activeUploads = 0;
    private static readonly uploadQueue: (() => void)[] = [];
    private static readonly MAX_CONCURRENT_UPLOADS = 10;
    private readonly MAX_FALLBACK_SIZE = 100 * 1024 * 1024; // 100MB limit for memory fallback
    private readonly MAX_DISK_SIZE = 2000 * 1024 * 1024; // 2GB limit for disk fallback
    private readonly TEMP_DIR = join(tmpdir(), 'genie-ai-bot');

    constructor(
        private readonly chatRepo: IChatRepository,
        logger: ILogger
    ) {
        this.logger = logger.child({ className: 'GoogleGenAIAdapter' });
        this.client = new GoogleGenAI({ apiKey: config.ai.apiKey });
        this.model = config.ai.model;
        this.systemPrompt = config.ai.systemPrompt;
        this.fileUploader = new GoogleGenAIFileUploader(this.client, this.logger);
        this.initTempDir().catch(err => this.logger.error("Failed to initialize temp directory", err));
    }

    private async initTempDir() {
        try {
            await mkdir(this.TEMP_DIR, { recursive: true });
            // Cleanup orphaned files from previous runs
            const files = await readdir(this.TEMP_DIR);
            for (const file of files) {
                await unlink(join(this.TEMP_DIR, file)).catch(() => { });
            }
            this.logger.debug(`Initialized temp directory and cleaned up orphans: ${this.TEMP_DIR}`);
        } catch (error) {
            this.logger.error("Failed to initialize temp directory", error);
        }
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
                const attachmentParts = await Promise.all(
                    currentMessage.attachments.map(att => this.resolveAttachmentPart(att, currentMessage.id))
                );
                for (const part of attachmentParts) {
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
            const attachmentParts = await Promise.all(
                msg.attachments.map(att => this.resolveAttachmentPart(att, msg.id))
            );
            for (const part of attachmentParts) {
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

        // Acquire concurrency slot
        if (GoogleGenAIAdapter.activeUploads >= GoogleGenAIAdapter.MAX_CONCURRENT_UPLOADS) {
            await new Promise<void>(resolve => GoogleGenAIAdapter.uploadQueue.push(resolve));
        }
        GoogleGenAIAdapter.activeUploads++;

        let releaseFallbackLock: (() => void) | undefined;

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
                releaseFallbackLock = resolve;

                this.logger.info(`Locked fallback upload. Starting two-tier download (Memory up to ${this.MAX_FALLBACK_SIZE / 1024 / 1024}MB, Disk up to ${this.MAX_DISK_SIZE / 1024 / 1024}MB)...`);

                const result = await this.readStreamWithTwoTierLimits(stream, this.MAX_FALLBACK_SIZE, this.MAX_DISK_SIZE);
                let uploadResponse;

                try {
                    const uploadInput = result.filePath || new Blob([result.buffer!], { type: attachment.mimeType });

                    uploadResponse = await this.client.files.upload({
                        file: uploadInput,
                        config: {
                            mimeType: attachment.mimeType,
                        }
                    });
                } finally {
                    if (result.filePath) {
                        await unlink(result.filePath).catch((err) => {
                            this.logger.error(`Failed to delete temp file ${result.filePath}`, err);
                        });
                    }
                }

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
            if (releaseFallbackLock) {
                this.logger.debug("Releasing fallback upload lock.");
                releaseFallbackLock();
            }

            // Release concurrency slot
            GoogleGenAIAdapter.activeUploads--;
            const next = GoogleGenAIAdapter.uploadQueue.shift();
            if (next) {
                next();
            }
        }
    }

    private async readStreamWithTwoTierLimits(
        stream: ReadableStream<Uint8Array>,
        memoryLimit: number,
        diskLimit: number
    ): Promise<{ buffer?: Buffer; filePath?: string }> {
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        const reader = stream.getReader();
        let tempFilePath: string | undefined;
        let fileHandle: FileHandle | undefined;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                totalSize += value.length;

                if (!tempFilePath && totalSize > memoryLimit) {
                    this.logger.info(`Memory limit exceeded (${totalSize} bytes), spilling to disk...`);
                    await mkdir(this.TEMP_DIR, { recursive: true });
                    tempFilePath = join(this.TEMP_DIR, `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`);
                    fileHandle = await open(tempFilePath, 'w');

                    // Write already read chunks
                    for (const chunk of chunks) {
                        await fileHandle.write(chunk);
                    }
                    chunks.length = 0; // Clear memory
                }

                if (tempFilePath && fileHandle) {
                    if (totalSize > diskLimit) {
                        await reader.cancel();
                        throw new AIProviderError(`File too large: exceeds disk limit of ${diskLimit / 1024 / 1024}MB.`);
                    }
                    await fileHandle.write(value);
                } else {
                    chunks.push(value);
                }
            }

            if (tempFilePath && fileHandle) {
                await fileHandle.close();
                fileHandle = undefined;
                return { filePath: tempFilePath };
            } else {
                return { buffer: Buffer.concat(chunks) };
            }
        } catch (error) {
            if (fileHandle) {
                await fileHandle.close();
            }
            if (tempFilePath) {
                await unlink(tempFilePath).catch(() => { });
            }
            throw error;
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
