import type { Message, MessageAttachment } from '../entities/message';

export interface IChatRepository {
    saveMessage(message: Message): Promise<void>;
    updateMessage(message: Message): Promise<void>;
    updateAttachment(messageId: string, attachmentId: string, attachment: Partial<MessageAttachment>): Promise<void>;
    getHistory(messageId: string, limit?: number): Promise<Message[]>;
}
