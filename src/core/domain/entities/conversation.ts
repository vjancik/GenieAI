import type { Message } from './message';

export interface ConversationProps {
	id: string;
	messages: Message[];
}

export class Conversation {
	public readonly id: string;
	private _messages: Message[];

	constructor(props: ConversationProps) {
		this.id = props.id;
		this._messages = props.messages;
	}

	get messages(): Message[] {
		return [...this._messages];
	}

	addMessage(message: Message) {
		// Invariants could be checked here (e.g. message order, branching rules)
		this._messages.push(message);
	}

	formatForAI(): string {
		let result = '';
		let attachmentCounter = 1;

		for (const message of this._messages) {
			const { text, nextAttachmentIndex } = message.formatForAI({
				authorName: (message.metadata.authorName as string) || undefined,
				attachmentStartIndex: attachmentCounter,
			});
			result += `${text}\n\n`;
			attachmentCounter = nextAttachmentIndex;
		}

		return result.trim();
	}

	/**
	 * Returns the most recent message in the conversation.
	 */
	get latestMessage(): Message | undefined {
		return this._messages[this._messages.length - 1];
	}

	/**
	 * Returns the full history including the new message,
	 * or just the history if reconstructing from storage.
	 */
	getTranscript(): Message[] {
		return this.messages;
	}
}
