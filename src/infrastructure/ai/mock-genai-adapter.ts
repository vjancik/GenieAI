import type { GenerationResult, IGenerativeAIModel } from '../../core/application/interfaces/illm-provider';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import type { Message } from '../../core/domain/entities/message';

export class MockGenAIAdapter implements IGenerativeAIModel {
	private logger: ILogger;
	constructor(logger: ILogger) {
		this.logger = logger.child({ className: 'MockGenAIAdapter' });
	}

	async generateContent(history: Message[]): Promise<GenerationResult> {
		const lastMessage = history[history.length - 1];
		if (!lastMessage) return { content: '' };

		const prompt = lastMessage.content;
		this.logger.debug(`[MockGenAI] Generating response for last message content: "${prompt}"`);

		// Simulate network delay
		await new Promise((resolve) => setTimeout(resolve, 800));

		// Simple mock logic
		let content = `I received your message: "${prompt}". As a mock agent, I can't really think yet, but I'm structured to do so!`;

		if (prompt.toLowerCase().includes('hello')) {
			content = "Hello there! I'm a Mock AI agent ready to help you.";
		} else if (prompt.toLowerCase().includes('time')) {
			content = `The current mock time is ${new Date().toLocaleTimeString()}`;
		}

		return { content };
	}
}
