import { Conversation } from '../entities/conversation';
import type { Message } from '../entities/message';
import type { IChatRepository } from '../repositories/chat-repository';

export class HistoryService {
	constructor(private readonly chatRepo: IChatRepository) {}

	async getConversation(messageId: string, limit?: number): Promise<Conversation> {
		const messages = await this.chatRepo.getHistory(messageId, limit);
		if (messages.length === 0) {
			throw new Error(`History not found for message ${messageId}`);
		}
		const rootMessage = messages[0];
		if (!rootMessage) {
			throw new Error(`History empty for message ${messageId}`);
		}
		return new Conversation({ id: rootMessage.id, messages });
	}

	createConversation(rootMessage: Message): Conversation {
		return new Conversation({ id: rootMessage.id, messages: [rootMessage] });
	}
}
