import { Message } from '../../core/domain/entities/message';
import type { IGenerativeAIModel } from '../../core/application/interfaces/illm-provider';
import type { ILogger } from '../../core/application/interfaces/logger.interface';

export class MockGenAIAdapter implements IGenerativeAIModel {
	private logger: ILogger;
	constructor(logger: ILogger) {
		this.logger = logger.child({ className: 'MockGenAIAdapter' });
	}

	async generateContent(history: Message[], prompt: string): Promise<string> {
		this.logger.debug(`[MockGenAI] Generating response for prompt: "${prompt}"`);
		this.logger.debug(`[MockGenAI] Context history length: ${history.length}`);

		// Simulate network delay
		await new Promise((resolve) => setTimeout(resolve, 800));

		// Simple mock logic
		if (prompt.toLowerCase().includes('hello')) {
			return "Hello there! I'm a Mock AI agent ready to help you.";
		}

		if (prompt.toLowerCase().includes('time')) {
			return `The current mock time is ${new Date().toLocaleTimeString()}`;
		}

		return `I received your message: "${prompt}". As a mock agent, I can't really think yet, but I'm structured to do so!`;
	}
}
