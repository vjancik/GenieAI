import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IAttachmentManager } from '../../src/core/application/interfaces/attachment-manager';
import type { ILogger } from '../../src/core/application/interfaces/logger.interface';
import { Message, type MessageAttachment, MessageSource } from '../../src/core/domain/entities/message';
import { Role } from '../../src/core/domain/value-objects/role';

// 1. Mock the @google/genai module BEFORE importing the component that uses it
const mockSendMessage = mock(async (_req: unknown) => ({
	text: 'Mocked AI Response',
}));

const mockChatsCreate = mock(() => ({
	sendMessage: mockSendMessage,
}));

const mockFilesUpload = mock(async () => ({
	uri: 'mock-file-uri',
	state: 'ACTIVE',
	name: 'mock-file-name',
}));

const mockFilesGet = mock(async () => ({
	state: 'ACTIVE',
	name: 'mock-file-name',
}));

mock.module('@google/genai/node', () => ({
	GoogleGenAI: mock(() => ({
		chats: {
			create: mockChatsCreate,
		},
		files: {
			upload: mockFilesUpload,
			get: mockFilesGet,
		},
	})),
	FileState: {
		ACTIVE: 'ACTIVE',
		PROCESSING: 'PROCESSING',
		FAILED: 'FAILED',
		STATE_UNSPECIFIED: 'STATE_UNSPECIFIED',
	},
}));

// 2. Import the component under test
import { GoogleGenAIAdapter } from '../../src/infrastructure/ai/google-genai-adapter';

const mockLogger: ILogger = {
	info: mock(),
	error: mock(),
	debug: mock(),
	warn: mock(),
	fatal: mock(),
	child: mock(() => mockLogger),
};

describe('GoogleGenAIAdapter', () => {
	let adapter: GoogleGenAIAdapter;
	let mockAttachmentManager: IAttachmentManager;

	beforeEach(() => {
		// Reset mocks
		mockSendMessage.mockClear();
		mockChatsCreate.mockClear();
		mockFilesUpload.mockClear();
		mockFilesGet.mockClear();

		mockAttachmentManager = {
			getAttachmentStream: mock(async (_attachment: MessageAttachment, _messageId: string) => ({
				stream: new ReadableStream(),
				mimeType: 'text/plain',
			})),
			updateAttachmentMetadata: mock(
				async (_messageId: string, _attachmentId: string, _metadata: Partial<MessageAttachment>) => {},
			),
		};

		// Instantiate adapter
		adapter = new GoogleGenAIAdapter(mockAttachmentManager, mockLogger, {
			apiKey: 'mock-key',
			model: 'mock-model',
			systemPrompt: 'mock-system-prompt',
			attachmentMemoryLimit: 20 * 1024 * 1024,
			attachmentDiskLimit: 100 * 1024 * 1024,
		});
	});

	test('should generate content successfully', async () => {
		const history: Message[] = [
			Message.create({
				id: '1',
				role: Role.USER,
				content: 'Hello',
				timestamp: new Date(),
				source: MessageSource.DISCORD,
				metadata: { authorName: 'Tester' },
			}),
		];

		// Pass history only
		const response = await adapter.generateContent(history);

		expect(response.content).toBe('Mocked AI Response');
		expect(mockChatsCreate).toHaveBeenCalled();
		expect(mockSendMessage).toHaveBeenCalled();
	});

	test('should handle text conversion correctly', async () => {
		const history: Message[] = [
			Message.create({
				id: '1',
				role: Role.USER,
				content: 'Test Prompt',
				timestamp: new Date(),
				source: MessageSource.DISCORD,
				metadata: { authorName: 'Tester' },
			}),
		];

		// Pass history only
		await adapter.generateContent(history);

		const callArgs = mockSendMessage.mock.calls[0];
		if (!callArgs) throw new Error('mockSendMessage should have been called');
		const payload = callArgs[0] as { message: { text: string }[] };

		// payload is { message: [ { text: 'Test Prompt' } ] }
		// The adapter should have formatted the message
		expect(payload.message).toBeDefined();
		const parts = payload.message;
		expect(parts[0]?.text).toContain('Test Prompt');
	});
});
