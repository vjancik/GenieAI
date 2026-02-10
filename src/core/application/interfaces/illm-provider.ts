import type { Message, Metadata } from '../../domain/entities/message';

export interface AttachmentUpdate<TPersistence extends Metadata = Metadata> {
	messageId: string;
	attachmentId: string;
	persistenceMetadata: TPersistence;
}

export interface GenerationResult<TPersistence extends Metadata = Metadata> {
	content: string;
	attachmentUpdates?: AttachmentUpdate<TPersistence>[];
}

export interface IGenerativeAIModel<TPersistence extends Metadata = Metadata> {
	generateContent(history: Message[], prompt: string): Promise<GenerationResult<TPersistence>>;
}
