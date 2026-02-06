import type { Message, MessageAttachment } from '../../core/domain/entities/message';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';

export class InMemoryChatRepository implements IChatRepository {
    private messages: Map<string, Message> = new Map();
    private externalIdMap: Map<string, string> = new Map(); // Maps externalId -> internalId

    async saveMessage(message: Message): Promise<void> {
        this.messages.set(message.id, message);
        this.indexExternalId(message);
        // Simulate async DB delay
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    async updateMessage(message: Message): Promise<void> {
        if (!this.messages.has(message.id)) {
            throw new Error(`Message with ID ${message.id} not found`);
        }
        this.messages.set(message.id, message);
        this.indexExternalId(message);
    }

    async updateAttachment(messageId: string, attachmentId: string, update: Partial<MessageAttachment>): Promise<void> {
        // Resolve internal ID
        const internalId = this.externalIdMap.get(messageId) || messageId;
        const msg = this.messages.get(internalId);
        if (!msg) return; // Or throw

        const attachment = msg.attachments.find(a => a.id === attachmentId);
        if (attachment) {
            Object.assign(attachment, update);
        }
    }

    private indexExternalId(message: Message) {
        if (message.metadata?.externalId) {
            this.externalIdMap.set(message.metadata.externalId, message.id);
        }
    }

    async getHistory(messageIdOrExternalId: string, limit?: number): Promise<Message[]> {
        const history: Message[] = [];
        // Resolve internal ID if it's an external ID
        let currentId: string | undefined = this.externalIdMap.get(messageIdOrExternalId) || messageIdOrExternalId;
        const maxLimit = limit || 50;

        while (currentId && history.length < maxLimit) {
            const msg = this.messages.get(currentId);
            if (!msg) break;

            history.push(msg);

            // Resolve parent's internal ID if parentId is external
            if (msg.parentId) {
                currentId = this.externalIdMap.get(msg.parentId) || msg.parentId;
            } else {
                currentId = undefined;
            }
        }

        // Return from oldest to newest
        return history.reverse();
    }
}
