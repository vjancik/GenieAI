import { Client, GatewayIntentBits, Events, Message as DiscordMessage, TextChannel } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { SendMessageUseCase } from '../../core/application/use-cases/send-message.use-case';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { IDiscordRepository } from '../../core/domain/repositories/discord-repository';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';

export class DiscordBot {
    private client: Client;
    private logger: ILogger;

    constructor(
        private readonly sendMessageUseCase: SendMessageUseCase,
        private readonly chatRepo: IChatRepository,
        private readonly discordRepo: IDiscordRepository,
        logger: ILogger
    ) {
        this.logger = logger.child({ className: 'DiscordBot' });
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });

        this.setupListeners();
    }

    private setupListeners() {
        this.client.once(Events.ClientReady, (c) => {
            this.logger.info(`Ready! Logged in as ${c.user.tag}`);
        });

        this.client.on(Events.MessageCreate, async (message: DiscordMessage) => {
            await this.handleMessage(message);
        });
    }

    private splitMessage(text: string, maxLength: number = 2000): string[] {
        const chunks: string[] = [];
        let currentPosition = 0;

        while (currentPosition < text.length) {
            let chunk = text.substring(currentPosition, currentPosition + maxLength);

            // If not at the end, try to find a newline or space to break at
            if (currentPosition + maxLength < text.length) {
                const lastNewline = chunk.lastIndexOf('\n');
                if (lastNewline > maxLength * 0.8) {
                    chunk = text.substring(currentPosition, currentPosition + lastNewline + 1);
                } else {
                    const lastSpace = chunk.lastIndexOf(' ');
                    if (lastSpace > maxLength * 0.8) {
                        chunk = text.substring(currentPosition, currentPosition + lastSpace + 1);
                    }
                }
            }

            chunks.push(chunk);
            currentPosition += chunk.length;
        }

        return chunks;
    }

    private async handleMessage(message: DiscordMessage) {
        // Ignore bots to prevent loops
        if (message.author.bot) return;

        // Check Triggers: "!ai" prefix OR mention
        let content = message.content.trim();
        const lowerContent = content.toLowerCase();

        let isCommand = false;
        if (/^!ai(\s|$)/.test(lowerContent)) {
            isCommand = true;
            // Strip "!ai" and leading whitespace
            content = content.slice(3).trim();
        }

        const isMention = this.client.user && message.mentions.users.has(this.client.user.id);

        if (!isCommand && !isMention) {
            return;
        }

        // 1. Send "Thinking..." status message
        const thinkingMsg = await message.reply(`Thinking since <t:${Math.round(Date.now() / 1000)}:R>`);

        try {
            const allAttachments: MessageAttachment[] = [];
            let attachmentCounter = 1;

            // Helper to Format Message Block
            const formatMessageBlock = (msg: DiscordMessage, customContent?: string, label: string = "Message from user named") => {
                const authorName = msg.member?.displayName ?? msg.author.username;
                let text = `${label} ${authorName}\nMessage content:\n${customContent || msg.content}`;

                // Process Attachments for this message
                if (msg.attachments.size > 0) {
                    const indices: number[] = [];
                    for (const [_, attachment] of msg.attachments) {
                        allAttachments.push({
                            id: attachment.id,
                            url: attachment.url,
                            mimeType: attachment.contentType || 'application/octet-stream',
                        });
                        indices.push(attachmentCounter++);
                    }
                    text += `\nIncludes attachments: ${indices.map(i => `#${i}`).join(', ')}`;
                }
                return text;
            };

            const formattedContent = formatMessageBlock(message, content);
            let history: Message[] = [];
            let finalPrompt = formattedContent;
            let parentUuid: string | undefined = undefined;

            if (message.reference?.messageId) {
                parentUuid = await this.discordRepo.getMessageId(message.reference.messageId) || undefined;

                if (parentUuid) {
                    // We have history in our DB
                    history = await this.chatRepo.getHistory(parentUuid);
                } else {
                    // No history in DB, fetch from Discord to see if we should "fold"
                    try {
                        const refMessage = await message.fetchReference();
                        if (refMessage.author.id !== this.client.user?.id) {
                            // Fold referencing message for context
                            const refBlock = formatMessageBlock(refMessage, undefined, "Referring to message from user named");
                            finalPrompt = `${formattedContent}\n\n${refBlock}`;
                        }
                    } catch (e) {
                        this.logger.warn('Could not fetch reference for context folding');
                    }
                }
            }

            // Generate internal UUID for the user message
            const userUuid = uuidv4();

            // Execute Use Case
            // Note: conversationId should be the root of the thread. history[0] is oldest.
            const conversationId = (history.length > 0 && history[0]) ? history[0].id : userUuid;

            const aiMessage = await this.sendMessageUseCase.execute({
                conversationId,
                id: userUuid,
                content: finalPrompt,
                userId: message.author.id,
                history: history,
                parentId: parentUuid,
                attachments: allAttachments,
                externalId: message.id // Atomic mapping for user message
            });

            // Split and Send Response
            const chunks = this.splitMessage(aiMessage.content);

            // Delete the "Thinking..." message
            await thinkingMsg.delete().catch(() => { });

            let lastMsg = message;
            for (let i = 0; i < chunks.length; i++) {
                const sentMsg = await lastMsg.reply(chunks[i] || '');
                // Map each response chunk to the same internal AI message ID
                await this.discordRepo.saveMapping(sentMsg.id, aiMessage.id);
                lastMsg = sentMsg;
            }

        } catch (error) {
            this.logger.error('Error handling message:', error);
            // 3. Update status message with error
            await thinkingMsg.edit(`*Sorry, I encountered an error processing your request.*`);
        }
    }

    public async start(token: string) {
        if (!token) {
            throw new Error("Discord Token is missing");
        }
        await this.client.login(token);
    }
}
