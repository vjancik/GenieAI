import { beforeEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { AppError } from "../../../src/domain/errors/AppError.ts";

const testLogger = pino({ level: "silent" });

/**
 * Module-level mocks shared across all test instances.
 * `@google/genai` is mocked so `GoogleGenAIWithStreamingUpload` (which extends
 * `GoogleGenAI`) gets these methods injected via its base class mock, letting
 * us control behaviour per-test via `mockImplementationOnce`.
 */
const mockUploadStream = mock(async () => ({
    name: "files/test123",
    state: "ACTIVE",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/test123",
}));
const mockFilesGet = mock(async () => ({
    name: "files/test123",
    state: "ACTIVE",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/test123",
}));
const mockFilesDelete = mock(async () => {});

mock.module("@google/genai", () => ({
    FileState: {
        ACTIVE: "ACTIVE",
        PROCESSING: "PROCESSING",
        FAILED: "FAILED",
    },
    GoogleGenAI: class MockGoogleGenAI {
        uploadStream = mockUploadStream;
        readonly files = {
            get: mockFilesGet,
            delete: mockFilesDelete,
        };
    },
}));

// Provide a stub bun file handle: fixed size so byteLength is available without disk I/O.
mock.module("bun", () => ({
    file: (_path: string) => ({
        size: 1024,
        stream: () => new ReadableStream(),
    }),
}));

const { GenaiFileUploader } = await import("../../../src/infrastructure/attachments/GenaiFileUploader.ts");

const GEMINI_URI = "https://generativelanguage.googleapis.com/v1beta/files/test123";

beforeEach(() => {
    // mockReset clears both call history AND the mockImplementationOnce queue,
    // preventing leftover one-time impls from bleeding across tests.
    mockUploadStream.mockReset();
    mockFilesGet.mockReset();
    mockFilesDelete.mockReset();
    // Restore default ACTIVE response after reset
    mockUploadStream.mockImplementation(async () => ({
        name: "files/test123",
        state: "ACTIVE",
        uri: GEMINI_URI,
    }));
    mockFilesGet.mockImplementation(async () => ({
        name: "files/test123",
        state: "ACTIVE",
        uri: GEMINI_URI,
    }));
    mockFilesDelete.mockImplementation(async () => {});
});

describe("GenaiFileUploader.upload", () => {
    test("returns geminiFileName and geminiUrl when file is immediately ACTIVE", async () => {
        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        const result = await uploader.upload("/tmp/test.png", "files/test123", "image/png", "test.png");

        expect(result.geminiFileName).toBe("files/test123");
        expect(result.geminiUrl).toBe(GEMINI_URI);
        // get() should not be called if already ACTIVE after upload
        expect(mockFilesGet).not.toHaveBeenCalled();
    });

    test("calls uploadStream with correct parameters", async () => {
        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        await uploader.upload("/tmp/photo.jpg", "files/my-uuid", "image/jpeg", "photo.jpg");

        expect(mockUploadStream).toHaveBeenCalledWith(
            // First arg is a ReadableStream — only validate the config object
            expect.anything(),
            expect.objectContaining({
                name: "files/my-uuid",
                mimeType: "image/jpeg",
                displayName: "photo.jpg",
                byteLength: expect.any(Number),
            }),
        );
    });

    test("throws AppError when file reaches FAILED state", async () => {
        mockUploadStream.mockImplementationOnce(async () => ({
            name: "files/test123",
            state: "FAILED",
            uri: null as unknown as string,
        }));

        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        await expect(uploader.upload("/tmp/test.png", "files/test123", "image/png", "test.png")).rejects.toBeInstanceOf(
            AppError,
        );
    });

    test("throws AppError when ACTIVE file has no URI", async () => {
        mockUploadStream.mockImplementationOnce(async () => ({
            name: "files/test123",
            state: "ACTIVE",
            uri: null as unknown as string,
        }));

        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        await expect(uploader.upload("/tmp/test.png", "files/test123", "image/png", "test.png")).rejects.toBeInstanceOf(
            AppError,
        );
    });
});

describe("GenaiFileUploader.uploadStream", () => {
    test("returns geminiFileName and geminiUrl when file is immediately ACTIVE", async () => {
        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        const result = await uploader.uploadStream(new ReadableStream(), "files/test123", "image/png", "test.png", 512);

        expect(result.geminiFileName).toBe("files/test123");
        expect(result.geminiUrl).toBe(GEMINI_URI);
        expect(mockFilesGet).not.toHaveBeenCalled();
    });

    test("passes stream and config to ai.uploadStream", async () => {
        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });
        const stream = new ReadableStream();

        await uploader.uploadStream(stream, "files/my-uuid", "video/mp4", "clip.mp4", 4096);

        expect(mockUploadStream).toHaveBeenCalledWith(
            stream,
            expect.objectContaining({
                name: "files/my-uuid",
                mimeType: "video/mp4",
                displayName: "clip.mp4",
                byteLength: 4096,
            }),
        );
    });

    test("throws AppError when file reaches FAILED state", async () => {
        mockUploadStream.mockImplementationOnce(async () => ({
            name: "files/test123",
            state: "FAILED",
            uri: null as unknown as string,
        }));

        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        await expect(
            uploader.uploadStream(new ReadableStream(), "files/test123", "image/png", "test.png", 512),
        ).rejects.toBeInstanceOf(AppError);
    });
});

describe("GenaiFileUploader.deleteFile", () => {
    test("calls ai.files.delete with the provided file name", async () => {
        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        await uploader.deleteFile("files/test123");

        expect(mockFilesDelete).toHaveBeenCalledWith({ name: "files/test123" });
    });

    test("resolves without throwing even when the API throws (file already expired)", async () => {
        mockFilesDelete.mockImplementationOnce(async () => {
            throw new Error("File not found");
        });

        const uploader = new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
            geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
        });

        // Errors are swallowed — file may have already expired
        await expect(uploader.deleteFile("files/gone")).resolves.toBeUndefined();
    });
});
