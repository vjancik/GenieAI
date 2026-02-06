import { Client, GatewayIntentBits, Events, Message as DiscordMessage } from 'discord.js';
import { SendMessageUseCase } from '../../core/application/use-cases/send-message.use-case';
import { MessageChainService } from './services/message-chain.service';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';

export class DiscordBot {
    private client: Client;
    private chainService: MessageChainService;

    constructor(
        private readonly sendMessageUseCase: SendMessageUseCase,
        private readonly chatRepo: IChatRepository // Injected for metadata updates
    ) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });

        this.chainService = new MessageChainService(this.client);
        this.setupListeners();
    }

    private setupListeners() {
        this.client.once(Events.ClientReady, (c) => {
            console.log(`Ready! Logged in as ${c.user.tag}`);
        });

        this.client.on(Events.MessageCreate, async (message: DiscordMessage) => {
            await this.handleMessage(message);
        });
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

        try {
            // Trigger "Typing..." indicator
            if ('sendTyping' in message.channel) {
                await message.channel.sendTyping();
            }

            const allAttachments: MessageAttachment[] = [];
            let attachmentCounter = 1;

            // Helper to Format Message Block
            const formatMessageBlock = (msg: DiscordMessage, customContent?: string, label: string = "Message from user") => {
                const authorName = msg.member?.displayName ?? msg.author.username;
                let text = `${label}: ${authorName}\n${customContent || msg.content}`;

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

            let history: Message[] = [];
            let finalPrompt = "";

            if (message.reference?.messageId) {
                const refMessage = await message.fetchReference();

                if (refMessage.author.id !== this.client.user?.id) {
                    // Fold referencing message
                    // Order: Current Message -> Referenced Message (as context)

                    // 1. Format Current Message
                    // Note: If isCommand, 'content' is already stripped. 
                    // But if referencing, we might be replying.
                    const currentBlock = formatMessageBlock(message, content, "Message from user");

                    // 2. Format Referenced Message
                    const refBlock = formatMessageBlock(refMessage, undefined, "Referring to message from user");

                    finalPrompt = `${currentBlock}\n\n${refBlock}`;
                } else {
                    // Let's apply the formatting to the current message regardless, to be safe and consistent.
                    finalPrompt = formatMessageBlock(message, content);
                    history = await this.chainService.getReplyChain(message);
                }
            } else {
                // No reference
                finalPrompt = formatMessageBlock(message, content);
            }

            // Execute Use Case
            const response = await this.sendMessageUseCase.execute({
                conversationId: message.id,
                id: message.id,
                content: finalPrompt,
                userId: message.author.id,
                history: history,
                parentId: message.reference?.messageId,
                attachments: allAttachments
            });

            const sentDiscordMsg = await message.reply(response.content);

            const updatedMessage = new Message({
                ...response,
                metadata: {
                    ...response.metadata,
                    externalId: sentDiscordMsg.id,
                    discordChannelId: sentDiscordMsg.channelId,
                }
            });
            await this.chatRepo.updateMessage(updatedMessage);

        } catch (error) {
            console.error('Error handling message:', error);
            await message.reply('Sorry, I encountered an error processing your request.');
        }
    }

    public async start(token: string) {
        if (!token) {
            throw new Error("Discord Token is missing");
        }
        await this.client.login(token);
    }
}
