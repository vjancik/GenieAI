import { v4 as uuidv4 } from "uuid";
import { Message, type MessageAttachment } from '../../domain/entities/message';
import type { IChatRepository } from '../../domain/repositories/chat-repository';
import { Role } from '../../domain/value-objects/role';
import type { IGenerativeAIModel } from '../interfaces/illm-provider';

export interface SendMessageDTO {
    conversationId: string;
    content: string;
    userId?: string;
    history?: Message[];
    id?: string;
    parentId?: string;
    attachments?: MessageAttachment[];
}

export class SendMessageUseCase {
    constructor(
        private readonly chatRepo: IChatRepository,
        private readonly aiModel: IGenerativeAIModel
    ) { }

    async execute(dto: SendMessageDTO): Promise<Message> {
        // 1. Create and Save User Message
        const userMessage = new Message({
            id: dto.id || uuidv4(),
            role: Role.USER,
            content: dto.content,
            timestamp: new Date(),
            metadata: { userId: dto.userId },
            parentId: dto.parentId,
            attachments: dto.attachments
        });

        await this.chatRepo.saveMessage(userMessage);

        // 2. Load History
        // Use provided history (plus the new message) or fetch from repo
        let history: Message[];
        if (dto.history) {
            history = [...dto.history, userMessage];
        } else {
            // Fallback: If no history provided, try to walk back from current message's parent
            // This case might happen if we are using an interface that doesn't provide full history
            // and we rely on our own DB.
            history = dto.parentId
                ? [...(await this.chatRepo.getHistory(dto.parentId)), userMessage]
                : [userMessage];
        }

        // 3. Generate AI Response
        // We strictly separate the prompt from history if the API requires it, 
        // or pass everything as history. 
        // Here we pass the history (which includes the latest user message) to the model.
        const aiResponseText = await this.aiModel.generateContent(history, dto.content);

        // 4. Create and Save AI Message
        const aiMessage = new Message({
            id: uuidv4(),
            role: Role.ASSISTANT,
            content: aiResponseText,
            timestamp: new Date(),
            parentId: userMessage.id // AI response is a child of User Message
        });

        await this.chatRepo.saveMessage(aiMessage);

        return aiMessage;
    }
}
