import { Message } from '../../domain/entities/message';

export interface IGenerativeAIModel {
    generateContent(history: Message[], prompt: string): Promise<string>;
}
