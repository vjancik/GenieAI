import { describe, test, expect, mock, beforeEach } from "bun:test";
import { SendMessageUseCase, type SendMessageDTO } from "../../src/core/application/use-cases/send-message.use-case";
import { Message } from "../../src/core/domain/entities/message";
import { Role } from "../../src/core/domain/value-objects/role";
import type { IChatRepository } from "../../src/core/domain/repositories/chat-repository";
import type { IGenerativeAIModel } from "../../src/core/application/interfaces/illm-provider";
import type { ILogger } from "../../src/core/application/interfaces/logger.interface";

const mockLogger = {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
} as unknown as ILogger;

describe("SendMessageUseCase", () => {
    let useCase: SendMessageUseCase;
    let mockChatRepo: IChatRepository;
    let mockAIModel: IGenerativeAIModel;

    beforeEach(() => {
        // Initialize fresh mocks for each test to ensure no state leakage
        mockChatRepo = {
            saveMessage: mock(async () => { }),
            getHistory: mock(async () => []),
            updateMessage: mock(async () => { }),
            updateAttachment: mock(async () => { }),
            findById: mock(async () => null),
        } as unknown as IChatRepository;

        mockAIModel = {
            // Default implementation returns a simple string
            generateContent: mock(async () => "AI Response"),
        } as unknown as IGenerativeAIModel;

        useCase = new SendMessageUseCase(mockChatRepo, mockAIModel, mockLogger);
    });

    test("should save user message, generate response, and save AI message", async () => {
        const dto: SendMessageDTO = {
            conversationId: "conv-123",
            content: "Hello AI",
            userId: "user-456"
        };

        const result = await useCase.execute(dto);

        // Verify User Message Saved
        expect(mockChatRepo.saveMessage).toHaveBeenCalledTimes(2);

        // Check 1st call (User Message)
        const saveCalls = (mockChatRepo.saveMessage as any).mock.calls;
        const userMessage = saveCalls[0]?.[0] as Message;
        expect(userMessage?.content).toBe("Hello AI");
        expect(userMessage?.role).toBe(Role.USER);

        // Verify AI Generation
        expect(mockAIModel.generateContent).toHaveBeenCalledTimes(1);

        // Check 2nd call (AI Message)
        const aiMessage = saveCalls[1]?.[0] as Message;
        expect(aiMessage?.content).toBe("AI Response");
        expect(aiMessage?.role).toBe(Role.ASSISTANT);

        expect(result).toBe(aiMessage);
    });

    test("should include history in prompt if provided", async () => {
        const historyMock: Message[] = [
            new Message({ id: "1", role: Role.USER, content: "Prev 1", timestamp: new Date() }),
            new Message({ id: "2", role: Role.ASSISTANT, content: "Prev 2", timestamp: new Date() })
        ];

        const dto: SendMessageDTO = {
            conversationId: "conv-123",
            content: "Follow up",
            history: historyMock
        };

        await useCase.execute(dto);

        const aiCalls = (mockAIModel.generateContent as any).mock.calls;
        // Verify history passed to generateContent
        const historyPassed = aiCalls[0][0] as Message[];

        // Expected: [Prev 1, Prev 2, Follow up]
        expect(historyPassed).toHaveLength(3);
        expect(historyPassed[0]?.content).toBe("Prev 1");
        expect(historyPassed[2]?.content).toBe("Follow up");
    });

    test("should fetch history from repo if parentId is provided but no history array", async () => {
        const historyMock: Message[] = [
            new Message({ id: "parent", role: Role.ASSISTANT, content: "Parent Msg", timestamp: new Date() })
        ];

        // Override getHistory for this specific instance
        mockChatRepo.getHistory = mock(async () => historyMock);

        const dto: SendMessageDTO = {
            conversationId: "conv-123",
            content: "Reply to parent",
            parentId: "parent"
        };

        await useCase.execute(dto);

        expect(mockChatRepo.getHistory).toHaveBeenCalledWith("parent");

        const aiCalls = (mockAIModel.generateContent as any).mock.calls;
        const historyPassed = aiCalls[0][0] as Message[];

        // Expected: [Parent Msg, Reply to parent]
        expect(historyPassed).toHaveLength(2);
        expect(historyPassed[0]?.content).toBe("Parent Msg");
    });
});
