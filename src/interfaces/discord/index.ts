import { Client, GatewayIntentBits, Events, Message as DiscordMessage, TextChannel, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, type Interaction } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { SendMessageUseCase } from '../../core/application/use-cases/send-message.use-case';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { IDiscordMessageMappingRepository } from '../../core/domain/repositories/discord-message-mapping-repository';
import type { IDiscordMessagePageRepository } from '../../core/domain/repositories/discord-message-page-repository';
import { GetNextMessagePageUseCase } from '../../core/application/use-cases/get-next-message-page.use-case';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';
import { ApplicationError, DiscordError } from '../../core/domain/errors/application-error';

export class DiscordBot {
    private logger: ILogger;
    private processingInteractions: Set<string> = new Set(); // In-memory lock for interactions

    constructor(
        public readonly client: Client,
        private readonly sendMessageUseCase: SendMessageUseCase,
        private readonly getNextMessagePageUseCase: GetNextMessagePageUseCase,
        private readonly chatRepo: IChatRepository,
        private readonly discordMessageMappingRepo: IDiscordMessageMappingRepository,
        private readonly discordMessagePageRepo: IDiscordMessagePageRepository,
        logger: ILogger
    ) {
        this.logger = logger.child({ className: 'DiscordBot' });

        this.setupListeners();
    }

    private setupListeners() {
        this.client.once(Events.ClientReady, (c) => {
            this.logger.info(`Ready! Logged in as ${c.user.tag}`);
        });

        this.client.on(Events.MessageCreate, async (message: DiscordMessage) => {
            await this.handleMessage(message);
        });

        this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
            await this.handleInteraction(interaction);
        });
    }

    private splitMessage(text: string, maxLength: number = 2000): { firstChunk: string; nextOffset?: number } {
        if (text.length <= maxLength) {
            return { firstChunk: text };
        }

        let chunk = text.substring(0, maxLength);

        // Smart split
        if (maxLength < text.length) {
            const lastNewline = chunk.lastIndexOf('\n');
            if (lastNewline > maxLength * 0.8) {
                chunk = text.substring(0, lastNewline + 1);
            } else {
                const lastSpace = chunk.lastIndexOf(' ');
                if (lastSpace > maxLength * 0.8) {
                    chunk = text.substring(0, lastSpace + 1);
                }
            }
        }

        return {
            firstChunk: chunk,
            nextOffset: chunk.length
        };
    }

    private createPaginationButton(pageId: string): ActionRowBuilder<ButtonBuilder> {
        const nextButton = new ButtonBuilder()
            .setCustomId(`next_page:${pageId}`)
            .setLabel('Next Page')
            .setStyle(ButtonStyle.Primary);

        return new ActionRowBuilder<ButtonBuilder>().addComponents(nextButton);
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
                            discordMessageId: msg.id,
                            channelId: msg.channelId,
                            url: attachment.url,
                            name: attachment.name,
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
                parentUuid = await this.discordMessageMappingRepo.getMessageId(message.reference.messageId) || undefined;

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
                        throw new DiscordError('Failed to fetch referenced message from Discord for context folding', e);
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

            // Split and Send Response (First Page Only)
            const { firstChunk, nextOffset } = this.splitMessage(aiMessage.content);

            // Delete the "Thinking..." message
            await thinkingMsg.delete().catch(() => { });

            try {
                let sentMsg: DiscordMessage;

                if (nextOffset && nextOffset < aiMessage.content.length) {
                    // Create page record
                    const pageId = await this.discordMessagePageRepo.create({
                        messageId: aiMessage.id,
                        offset: nextOffset
                    });

                    const row = this.createPaginationButton(pageId);
                    sentMsg = await message.reply({ content: firstChunk, components: [row] });
                } else {
                    sentMsg = await message.reply(firstChunk);
                }

                // Map response chunk to internal AI message ID
                await this.discordMessageMappingRepo.saveMapping(sentMsg.id, aiMessage.id);

            } catch (error) {
                // If it's a DatabaseError from saveMapping, it's already caught by the outer catch.
                // But we want to explicitly pinpoint Discord failures here.
                if (error instanceof ApplicationError) throw error;
                throw new DiscordError('Failed to send response to Discord', error);
            }

        } catch (error) {
            this.logger.error('Error handling message:', error);

            let userFriendlyMessage = 'Sorry, I encountered an unexpected error processing your request.';

            if (error instanceof ApplicationError) {
                userFriendlyMessage = `${error.name}: ${error.message}`;
            }

            // Update status message with error
            await thinkingMsg.edit(`*${userFriendlyMessage}*`).catch(() => {
                // Fallback if thinkingMsg cannot be edited
                message.reply(`*${userFriendlyMessage}*`).catch(() => { });
            });
        }
    }

    private async handleInteraction(interaction: Interaction) {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('next_page:')) return;

        const pageId = interaction.customId.split(':')[1];
        if (!pageId) return;

        // In-memory locking
        if (this.processingInteractions.has(pageId)) {
            // Already processing this page, just acknowledge to stop spinner
            await interaction.deferUpdate();
            return;
        }

        this.processingInteractions.add(pageId);

        try {
            await interaction.deferUpdate(); // Acknowledge button click first

            const result = await this.getNextMessagePageUseCase.execute({ pageId });

            if (!result) {
                // Page not found or already processed (race condition passed lock check but db check failed?)
                // Remove button if it's invalid
                try {
                    await interaction.message.edit({ components: [] });
                } catch (e) { }
                return;
            }

            // Send next chunk
            let nextMsgPayload: any = { content: result.content };

            if (result.nextPageId) {
                const row = this.createPaginationButton(result.nextPageId);
                nextMsgPayload.components = [row];
            }

            // Send as a reply to the message that had the button (interaction.message)
            const sentMsg = await interaction.message.reply(nextMsgPayload);

            // Save mapping
            await this.discordMessageMappingRepo.saveMapping(sentMsg.id, result.aiMessageId);

            // Remove button from original message ONLY after success
            try {
                await interaction.message.edit({ components: [] });
            } catch (e) {
                this.logger.warn('Failed to remove button from previous message:', e);
            }

            // Delete the processed page record
            await this.discordMessagePageRepo.delete(pageId);

        } catch (error) {
            this.logger.error('Error handling pagination interaction:', error);
            await interaction.followUp({ content: 'Failed to load next page.', ephemeral: true }).catch(() => { });
        } finally {
            this.processingInteractions.delete(pageId);
        }
    }

    public async start(token: string) {
        if (!token) {
            throw new Error("Discord Token is missing");
        }
        await this.client.login(token);
    }
}
