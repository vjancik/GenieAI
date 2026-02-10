import type { Mock } from 'bun:test';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IGenerativeAIModel } from '../../src/core/application/interfaces/illm-provider';
import type { ILogger } from '../../src/core/application/interfaces/logger.interface';
import { type SendMessageDTO, SendMessageUseCase } from '../../src/core/application/use-cases/send-message.use-case';
import { Message, type MessageAttachment, MessageSource } from '../../src/core/domain/entities/message';
import type { IChatRepository } from '../../src/core/domain/repositories/chat-repository';
import { HistoryService } from '../../src/core/domain/services/history-service';
import { Role } from '../../src/core/domain/value-objects/role';
import { UuidGenerator } from '../../src/infrastructure/identity/uuid-generator';

const mockLogger: ILogger = {
	info: mock(),
	error: mock(),
	warn: mock(),
	debug: mock(),
	fatal: mock(),
	child: mock(() => mockLogger),
};

describe('SendMessageUseCase', () => {
	let useCase: SendMessageUseCase;
	let mockChatRepo: IChatRepository;
	let mockAIModel: IGenerativeAIModel;

	beforeEach(() => {
		// Initialize fresh mocks for each test to ensure no state leakage
		mockChatRepo = {
			saveMessage: mock(async (_message: Message, _externalId?: string) => {}),
			getHistory: mock(async (_messageId: string, _limit?: number) => []),
			updateMessage: mock(async (_message: Message) => {}),
			updateAttachment: mock(
				async (
					_messageId: string,
					_attachmentId: string,
					_attachment: Partial<MessageAttachment<Record<string, unknown>, Record<string, unknown>>>,
				) => {},
			),
			findById: mock(async (_id: string) => null),
		};

		mockAIModel = {
			// Default implementation returns a simple string
			generateContent: mock(async (_history: Message[]) => ({ content: 'AI Response' })),
		};

		const historyService = new HistoryService(mockChatRepo);
		const idGenerator = new UuidGenerator();

		useCase = new SendMessageUseCase(mockChatRepo, mockAIModel, historyService, idGenerator, mockLogger);
	});

	test('should save user message, generate response, and save AI message', async () => {
		const dto: SendMessageDTO = {
			conversationId: 'conv-123',
			content: 'Hello AI',
			userId: 'user-456',
			source: MessageSource.DISCORD,
		};

		const result = await useCase.execute(dto);

		// Verify User Message Saved
		expect(mockChatRepo.saveMessage).toHaveBeenCalledTimes(2);

		// Check 1st call (User Message)
		const saveCalls = (mockChatRepo.saveMessage as Mock<IChatRepository['saveMessage']>).mock.calls;
		const userMessage = saveCalls[0]?.[0] as Message;
		expect(userMessage?.content).toBe('Hello AI');
		expect(userMessage?.role).toBe(Role.USER);

		// Verify AI Generation
		expect(mockAIModel.generateContent).toHaveBeenCalledTimes(1);

		// Check 2nd call (AI Message)
		const aiMessage = saveCalls[1]?.[0] as Message;
		expect(aiMessage?.content).toBe('AI Response');
		expect(aiMessage?.role).toBe(Role.ASSISTANT);

		expect(result).toBe(aiMessage);
	});

	test('should include history in prompt if provided', async () => {
		const historyMock: Message[] = [
			Message.create({
				id: '1',
				role: Role.USER,
				content: 'Prev 1',
				timestamp: new Date(),
				source: MessageSource.DISCORD,
			}),
			Message.create({
				id: '2',
				role: Role.ASSISTANT,
				content: 'Prev 2',
				timestamp: new Date(),
				source: MessageSource.DISCORD,
			}),
		];

		const dto: SendMessageDTO = {
			conversationId: 'conv-123',
			content: 'Follow up',
			history: historyMock,
			source: MessageSource.DISCORD,
		};

		await useCase.execute(dto);

		const aiCalls = (mockAIModel.generateContent as Mock<IGenerativeAIModel['generateContent']>).mock.calls;
		// Verify history passed to generateContent
		const historyPassed = aiCalls[0]?.[0];

		// Expected: [Prev 1, Prev 2, Follow up]
		expect(historyPassed).toHaveLength(3);
		// biome-ignore lint/style/noNonNullAssertion: Checked by toHaveLength above
		expect(historyPassed![0]?.content).toBe('Prev 1');
		// biome-ignore lint/style/noNonNullAssertion: Checked by toHaveLength above
		expect(historyPassed![2]?.content).toBe('Follow up');
	});

	test('should fetch history from repo if parentId is provided but no history array', async () => {
		const historyMock: Message[] = [
			Message.create({
				id: 'parent',
				role: Role.ASSISTANT,
				content: 'Parent Msg',
				timestamp: new Date(),
				source: MessageSource.DISCORD,
			}),
		];

		// Override getHistory for this specific instance
		mockChatRepo.getHistory = mock(async () => historyMock);

		const dto: SendMessageDTO = {
			conversationId: 'conv-123',
			content: 'Reply to parent',
			parentId: 'parent',
			source: MessageSource.DISCORD,
		};

		await useCase.execute(dto);

		expect(mockChatRepo.getHistory).toHaveBeenCalledWith('parent', undefined);

		const aiCalls = (mockAIModel.generateContent as Mock<IGenerativeAIModel['generateContent']>).mock.calls;
		const historyPassed = aiCalls[0]?.[0];

		// Expected: [Parent Msg, Reply to parent]
		expect(historyPassed).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: Checked by toHaveLength above
		expect(historyPassed![0]?.content).toBe('Parent Msg');
	});
});
