import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GoogleGenAIAdapter } from "../../src/infrastructure/ai/google-genai-adapter";
import type { IAttachmentManager } from "../../src/core/application/interfaces/attachment-manager";
import type { ILogger } from "../../src/core/application/interfaces/logger.interface";
import { Message } from "../../src/core/domain/entities/message";
import { Role } from "../../src/core/domain/value-objects/role";

// Mock the @google/genai module (New SDK)
const mockSendMessage = mock(async (req: any) => ({
    text: "Mocked AI Response"
}));

const mockChatsCreate = mock(() => ({
    sendMessage: mockSendMessage
}));

const mockFilesUpload = mock(async () => ({
    uri: "mock-file-uri",
    state: "ACTIVE",
    name: "mock-file-name"
}));

const mockFilesGet = mock(async () => ({
    state: "ACTIVE",
    name: "mock-file-name"
}));

// We need to mock the constructor of GoogleGenAI and its methods
mock.module("@google/genai", () => ({
    GoogleGenAI: mock(() => ({
        chats: {
            create: mockChatsCreate
        },
        files: {
            upload: mockFilesUpload,
            get: mockFilesGet
        }
    })),
    FileState: {
        ACTIVE: "ACTIVE",
        PROCESSING: "PROCESSING",
        FAILED: "FAILED",
        STATE_UNSPECIFIED: "STATE_UNSPECIFIED"
    }
}));

// Define logger mock, including child() method
const loggerMockBase = {
    info: mock(),
    error: mock(),
    debug: mock(),
    warn: mock(),
};

const mockLogger = {
    ...loggerMockBase,
    child: mock(() => mockLogger),
} as unknown as ILogger;

describe("GoogleGenAIAdapter", () => {
    let adapter: GoogleGenAIAdapter;
    let mockAttachmentManager: IAttachmentManager;

    beforeEach(() => {
        // Reset mocks
        mockSendMessage.mockClear();
        mockChatsCreate.mockClear();
        mockFilesUpload.mockClear();
        mockFilesGet.mockClear();

        mockAttachmentManager = {
            getAttachmentStream: mock(async () => ({
                stream: new ReadableStream(),
                mimeType: "text/plain"
            })),
            updateAttachmentMetadata: mock(async () => { }),
        } as IAttachmentManager;

        // Instantiate adapter
        adapter = new GoogleGenAIAdapter(mockAttachmentManager, mockLogger);
    });

    test("should generate content successfully", async () => {
        const history: Message[] = [
            new Message({ id: "1", role: Role.USER, content: "Hello", timestamp: new Date() })
        ];

        // Pass 'Hello' as prompt
        const response = await adapter.generateContent(history, "Hello");

        expect(response).toBe("Mocked AI Response");
        expect(mockChatsCreate).toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalled();
    });

    test("should handle text conversion correctly", async () => {
        const history: Message[] = [
            new Message({ id: "1", role: Role.USER, content: "Test Prompt", timestamp: new Date() })
        ];

        // Pass 'Test Prompt' as prompt
        await adapter.generateContent(history, "Test Prompt");

        const callArgs = mockSendMessage.mock.calls[0];
        if (!callArgs) throw new Error("mockSendMessage should have been called");
        const payload = callArgs[0] as any;

        // payload is { message: [ { text: 'Test Prompt' } ] }
        expect(payload.message).toBeDefined();
        const parts = payload.message;
        expect(parts[0].text).toBe("Test Prompt");
    });
});
