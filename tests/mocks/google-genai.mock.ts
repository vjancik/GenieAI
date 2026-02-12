import { mock } from 'bun:test';

export const mockSendMessage = mock(async (_req: unknown) => ({
	text: 'Mocked AI Response',
}));

export const mockGenerateContent = mock(async (_req: unknown) => ({
	text: 'Mocked AI Response',
}));

export const mockChatsCreate = mock(() => ({
	sendMessage: mockSendMessage,
}));

export const mockFilesUpload = mock(async () => ({
	uri: 'mock-file-uri',
	state: 'ACTIVE',
	name: 'mock-file-name',
}));

export const mockFilesGet = mock(async () => ({
	state: 'ACTIVE',
	name: 'mock-file-name',
}));
