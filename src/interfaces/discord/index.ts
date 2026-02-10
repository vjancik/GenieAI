import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	type Message as DjsMessage,
	Events,
	type Interaction,
} from 'discord.js';
import type { IIdentityGenerator } from '../../core/application/interfaces/identity-generator.interface';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import type { GetNextMessagePageUseCase } from '../../core/application/use-cases/get-next-message-page.use-case';
import type { SendMessageUseCase } from '../../core/application/use-cases/send-message.use-case';
import {
	DiscordAttachment,
	DiscordMessage,
	type Message,
	type MessageAttachment,
} from '../../core/domain/entities/message';
import { ApplicationError, DiscordError } from '../../core/domain/errors/application-error';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { IDiscordMessageMappingRepository } from '../../core/domain/repositories/discord-message-mapping-repository';
import type { IDiscordMessagePageRepository } from '../../core/domain/repositories/discord-message-page-repository';
import { Role } from '../../core/domain/value-objects/role';

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
		private readonly idGenerator: IIdentityGenerator,
		logger: ILogger,
	) {
		this.logger = logger.child({ className: 'DiscordBot' });

		this.setupListeners();
	}

	private setupListeners() {
		this.client.once(Events.ClientReady, (c) => {
			this.logger.info(`Ready! Logged in as ${c.user.tag}`);
		});

		this.client.on(Events.MessageCreate, async (message: DjsMessage) => {
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
			nextOffset: chunk.length,
		};
	}

	private createPaginationButton(pageId: string): ActionRowBuilder<ButtonBuilder> {
		const nextButton = new ButtonBuilder()
			.setCustomId(`next_page:${pageId}`)
			.setLabel('Next Page')
			.setStyle(ButtonStyle.Primary);

		return new ActionRowBuilder<ButtonBuilder>().addComponents(nextButton);
	}

	private async handleMessage(message: DjsMessage) {
		// Ignore bots to prevent loops
		if (message.author.bot) return;

		// Check Triggers: "!ai" prefix OR mention
		let content = message.content;
		const aiPrefixRegex = /^\s*!ai(?:\s+|$)/i;
		const match = content.match(aiPrefixRegex);

		let isCommand = false;
		if (match) {
			isCommand = true;
			// Strip prefix and trim remaining content
			content = content.slice(match[0].length).trim();
		} else {
			content = content.trim();
		}

		const botRole = message.guild?.members.me?.roles.botRole;
		const isUserMention = this.client.user && message.mentions.users.has(this.client.user.id);
		const isRoleMention = botRole && message.mentions.roles.has(botRole.id);
		const isMention = isUserMention || isRoleMention;

		if (!isCommand && !isMention) {
			return;
		}

		// 1. Send "Thinking..." status message
		const thinkingMsg = await message.reply(`Thinking since <t:${Math.round(Date.now() / 1000)}:R>`);

		try {
			const allAttachments: MessageAttachment[] = [];

			// 1. Prepare User Message Attachments
			for (const [_, attachment] of message.attachments) {
				allAttachments.push(
					new DiscordAttachment({
						id: attachment.id,
						url: attachment.url,
						name: attachment.name,
						mimeType: attachment.contentType || 'application/octet-stream',
						sourceMetadata: {
							discordMessageId: message.id,
							channelId: message.channelId,
						},
					}),
				);
			}

			const authorName = message.member?.displayName ?? message.author.username;
			const userUuid = this.idGenerator.generate();

			// Note: formatting for AI will now happen inside the Conversation aggregate or Use Case
			// but for now we still pass the formatted content to the Use Case to maintain compatibility
			// until we refactor SendMessageUseCase.

			let history: Message[] = [];
			let parentUuid: string | undefined;

			if (message.reference?.messageId) {
				parentUuid = (await this.discordMessageMappingRepo.getMessageId(message.reference.messageId)) || undefined;

				if (parentUuid) {
					history = await this.chatRepo.getHistory(parentUuid);
				} else {
					try {
						const refMessage = await message.fetchReference();
						if (refMessage.author.id !== this.client.user?.id) {
							// For "folded" context, we create a transient message
							const refAuthorName = refMessage.member?.displayName ?? refMessage.author.username;
							const refAttachments: MessageAttachment[] = [];
							for (const [_, att] of refMessage.attachments) {
								refAttachments.push(
									new DiscordAttachment({
										id: att.id,
										url: att.url,
										name: att.name,
										mimeType: att.contentType || 'application/octet-stream',
										sourceMetadata: { discordMessageId: refMessage.id, channelId: refMessage.channelId },
									}),
								);
							}

							const refMessageEntity = new DiscordMessage({
								id: this.idGenerator.generate(), // dummy id
								role: Role.USER,
								content: refMessage.content,
								timestamp: new Date(refMessage.createdTimestamp),
								attachments: refAttachments,
								metadata: { userId: refMessage.author.id, authorName: refAuthorName, isTransient: true },
							});
							history = [refMessageEntity];
						}
					} catch (e) {
						throw new DiscordError('Failed to fetch referenced message from Discord for context folding', e);
					}
				}
			}

			const userMessage = new DiscordMessage({
				id: userUuid,
				role: Role.USER,
				content: content,
				timestamp: new Date(),
				attachments: allAttachments,
				metadata: { userId: message.author.id, authorName },
				parentId: parentUuid,
			});

			const conversationId = history.length > 0 && history[0] ? history[0].id : userUuid;

			// We'll update the Use Case next to accept a Conversation or just the latest message.
			// For now, let's keep the DTO as is but update how we call it.
			const aiMessage = await this.sendMessageUseCase.execute({
				conversationId,
				id: userUuid,
				content: userMessage.content, // Pass original content, use case will format
				userId: message.author.id,
				history: history,
				parentId: parentUuid,
				attachments: allAttachments,
				externalId: message.id,
			});

			// Split and Send Response (First Page Only)
			const { firstChunk, nextOffset } = this.splitMessage(aiMessage.content);

			// Delete the "Thinking..." message
			await thinkingMsg.delete().catch(() => {});

			try {
				let sentMsg: DjsMessage;

				if (nextOffset && nextOffset < aiMessage.content.length) {
					// Create page record
					const pageId = await this.discordMessagePageRepo.create({
						messageId: aiMessage.id,
						offset: nextOffset,
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
				message.reply(`*${userFriendlyMessage}*`).catch(() => {});
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
				} catch (_e) {}
				return;
			}

			// Send next chunk
			const nextMsgPayload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] } = {
				content: result.content,
			};

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
			await interaction.followUp({ content: 'Failed to load next page.', ephemeral: true }).catch(() => {});
		} finally {
			this.processingInteractions.delete(pageId);
		}
	}

	public async start(token: string) {
		if (!token) {
			throw new Error('Discord Token is missing');
		}
		await this.client.login(token);
	}
}
