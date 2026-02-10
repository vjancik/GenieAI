import type { Conversation } from '../entities/conversation';

export class ChatContextService {
	/**
	 * Formats a conversation for AI consumption.
	 * This encapsulates how the AI "perceives" the chat history.
	 */
	formatForAI(conversation: Conversation): string {
		return conversation.formatForAI();
	}

	/**
	 * Formats a single message for AI (e.g. for simple completion without full history).
	 */
	formatMessage(
		message: { formatForAI: (options: { authorName?: string }) => { text: string } },
		authorName?: string,
	): string {
		const result = message.formatForAI({ authorName });
		return result.text;
	}
}
