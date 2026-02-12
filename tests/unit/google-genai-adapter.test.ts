import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import type { IAttachmentManager } from '../../src/core/application/interfaces/attachment-manager';
import type { ILogger } from '../../src/core/application/interfaces/logger.interface';
import { Message, type MessageAttachment, MessageSource } from '../../src/core/domain/entities/message';
import { Role } from '../../src/core/domain/value-objects/role';

import { mockFilesGet, mockFilesUpload, mockGenerateContent } from '../mocks/google-genai.mock';

mock.module('@google/genai/node', () => ({
	GoogleGenAI: mock(() => ({
		models: {
			generateContent: mockGenerateContent,
		},
		files: {
			upload: mockFilesUpload,
			get: mockFilesGet,
		},
	})),
	createUserContent: (parts: unknown) => ({ role: 'user', parts }),
	createModelContent: (parts: unknown) => ({ role: 'model', parts }),
	createPartFromText: (text: string) => ({ text }),
	createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
	createPartFromBase64: (data: string, mimeType: string) => ({ inlineData: { data, mimeType } }),
	FileState: {
		ACTIVE: 'ACTIVE',
		PROCESSING: 'PROCESSING',
		FAILED: 'FAILED',
		STATE_UNSPECIFIED: 'STATE_UNSPECIFIED',
	},
	ApiError: class ApiError extends Error {
		status: number;
		constructor({ message, status }: { message: string; status: number }) {
			super(message);
			this.status = status;
			this.name = 'ApiError';
		}
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
		mockGenerateContent.mockClear();
		mockFilesUpload.mockClear();
		mockFilesGet.mockClear();
		(mockLogger.warn as Mock<ILogger['warn']>).mockClear();

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
			maxRetries: 3,
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

		const response = await adapter.generateContent(history);

		expect(response.content).toBe('Mocked AI Response');
		expect(mockGenerateContent).toHaveBeenCalled();
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

		await adapter.generateContent(history);

		const callArgs = mockGenerateContent.mock.calls[0];
		if (!callArgs) throw new Error('mockGenerateContent should have been called');
		const payload = callArgs[0] as { contents: unknown[] };

		expect(payload.contents).toBeDefined();
		const contents = payload.contents;
		// The last message in history is the second turn (index 1) in googleHistory
		// Wait, history only has 1 message here.
		expect((contents[0] as { parts: { text: string }[] }).parts[0]?.text).toContain('Test Prompt');
	});

	test('should retry on 503 error and eventually succeed', async () => {
		mockGenerateContent.mockImplementationOnce(async () => {
			const { ApiError } = await import('@google/genai/node');
			throw new ApiError({ message: 'Service Unavailable', status: 503 });
		});

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

		const response = await adapter.generateContent(history);
		expect(response.content).toBe('Mocked AI Response');
		expect(mockGenerateContent).toHaveBeenCalledTimes(2);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Retryable error (attempt 1/3) due to HTTP 503'),
		);
	});

	test('should retry on 429 error and eventually succeed', async () => {
		mockGenerateContent.mockImplementationOnce(async () => {
			const { ApiError } = await import('@google/genai/node');
			throw new ApiError({ message: 'Rate Limit Exceeded', status: 429 });
		});

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

		const response = await adapter.generateContent(history);
		expect(response.content).toBe('Mocked AI Response');
		expect(mockGenerateContent).toHaveBeenCalledTimes(2);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Retryable error (attempt 1/3) due to HTTP 429'),
		);
	});

	test('should fail immediately on 404 error', async () => {
		mockGenerateContent.mockImplementationOnce(async () => {
			const { ApiError } = await import('@google/genai/node');
			throw new ApiError({ message: 'Model Not Found', status: 404 });
		});

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

		await expect(adapter.generateContent(history)).rejects.toThrow('Model not found');
		expect(mockGenerateContent).toHaveBeenCalledTimes(1);
	});

	test('should fail immediately on 400 error', async () => {
		mockGenerateContent.mockImplementationOnce(async () => {
			const { ApiError } = await import('@google/genai/node');
			throw new ApiError({ message: 'Invalid Request', status: 400 });
		});

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

		await expect(adapter.generateContent(history)).rejects.toThrow('Invalid request sent to Google GenAI API');
		expect(mockGenerateContent).toHaveBeenCalledTimes(1);
	});
});
