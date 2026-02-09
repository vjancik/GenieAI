import { ApplicationError } from '../../domain/errors/application-error';
import type { IChatRepository } from '../../domain/repositories/chat-repository';
import type { IDiscordMessagePageRepository } from '../../domain/repositories/discord-message-page-repository';

interface GetNextMessagePageInput {
	pageId: string;
}

interface GetNextMessagePageOutput {
	content: string;
	nextPageId?: string;
	aiMessageId: string;
}

export class GetNextMessagePageUseCase {
	constructor(
		private readonly pageRepo: IDiscordMessagePageRepository,
		private readonly chatRepo: IChatRepository,
		private readonly MAX_LENGTH: number = 2000,
	) {}

	async execute(input: GetNextMessagePageInput): Promise<GetNextMessagePageOutput | null> {
		// 1. Retrieve the page record (Do not delete yet - deletion handled by caller after success)
		const page = await this.pageRepo.findById(input.pageId);

		if (!page) {
			return null; // Page not found or already processed
		}

		// 2. Fetch full message content
		const message = await this.chatRepo.findById(page.messageId);
		if (!message) {
			throw new ApplicationError('Original message not found');
		}

		const text = message.content;
		const currentPosition = page.offset;

		// 3. Calculate next chunk
		let chunk = text.substring(currentPosition, currentPosition + this.MAX_LENGTH);

		// Smart split logic (duplicated from DiscordBot default logic, could be shared)
		if (currentPosition + this.MAX_LENGTH < text.length) {
			const lastNewline = chunk.lastIndexOf('\n');
			if (lastNewline > this.MAX_LENGTH * 0.8) {
				chunk = text.substring(currentPosition, currentPosition + lastNewline + 1);
			} else {
				const lastSpace = chunk.lastIndexOf(' ');
				if (lastSpace > this.MAX_LENGTH * 0.8) {
					chunk = text.substring(currentPosition, currentPosition + lastSpace + 1);
				}
			}
		}

		const nextOffset = currentPosition + chunk.length;
		let nextPageId: string | undefined;

		// 4. Create next page record if needed
		if (nextOffset < text.length) {
			nextPageId = await this.pageRepo.create({
				messageId: page.messageId,
				offset: nextOffset,
			});
		}

		return {
			content: chunk,
			nextPageId,
			aiMessageId: message.id,
		};
	}
}
