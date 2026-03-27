import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { File as GenaiFile } from "@google/genai";
import pino from "pino";
import { AppError } from "../../../src/domain/errors/AppError.ts";

const testLogger = pino({ level: "silent" });

const mockFilesGet = mock(
    async () =>
        ({
            name: "files/test123",
            state: "ACTIVE",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/test123",
        }) as unknown as GenaiFile,
);
const mockFilesDelete = mock(async () => {});

/**
 * Mock `@google/genai` so `GoogleGenAIWithStreamingUpload` (which extends `GoogleGenAI`)
 * inherits stubbed `files.get` / `files.delete`. The `uploadStream` method on the subclass
 * is defined in GoogleGenAI.ts and calls the module-level free functions directly, so we
 * mock those separately via spyOn after import.
 */
mock.module("@google/genai", () => ({
    FileState: {
        ACTIVE: "ACTIVE",
        PROCESSING: "PROCESSING",
        FAILED: "FAILED",
    },
    GoogleGenAI: class MockGoogleGenAI {
        readonly files = {
            get: mockFilesGet,
            delete: mockFilesDelete,
        };
    },
}));

const { GenaiFileUploader } = await import("../../../src/infrastructure/attachments/GenaiFileUploader.ts");
// Import the module namespace so we can spy on its free functions.
// GoogleGenAIWithStreamingUpload.uploadStream calls these directly.
const GoogleGenAIModule = await import("../../../src/infrastructure/attachments/GoogleGenAI.ts");

const GEMINI_URI = "https://generativelanguage.googleapis.com/v1beta/files/test123";
// TYPE COERCION: state is a FileState enum at runtime but plain strings satisfy the test cases.
const ACTIVE_FILE = { name: "files/test123", state: "ACTIVE", uri: GEMINI_URI } as unknown as GenaiFile;
const CHUNK_SIZE = 8 * 1024 * 1024; // must match UPLOAD_CHUNK_SIZE in GoogleGenAI.ts

beforeEach(() => {
    mockFilesGet.mockReset();
    mockFilesDelete.mockReset();
    mockFilesGet.mockImplementation(async () => ACTIVE_FILE);
    mockFilesDelete.mockImplementation(async () => {});
});

// spyOn mocks on module namespace objects persist across test files — restore after each test
// so they don't bleed into GoogleGenAI.test.ts which tests the real implementations.
afterEach(() => {
    (GoogleGenAIModule.uploadStreamSingleRequest as ReturnType<typeof spyOn>).mockRestore?.();
    (GoogleGenAIModule.initiateResumableUpload as ReturnType<typeof spyOn>).mockRestore?.();
    (GoogleGenAIModule.uploadStreamChunked as ReturnType<typeof spyOn>).mockRestore?.();
});

function makeUploader() {
    return new GenaiFileUploader("test-key", "test-api-key-id", testLogger, {
        geminiFileApi: { pollIntervalMs: 5_000, maxPollWaitMs: 120_000, fileStaleBeforeExpiryMinutes: 15 },
    });
}

describe("GenaiFileUploader.upload", () => {
    test("delegates to uploadStream with the file's stream and size", async () => {
        const uploader = makeUploader();
        const uploadStreamSpy = spyOn(uploader, "uploadStream").mockImplementation(async () => ({
            geminiFileName: "files/test123",
            geminiUrl: GEMINI_URI,
        }));

        await uploader.upload("/any/path.png", "files/test123", "image/png", "path.png");

        expect(uploadStreamSpy).toHaveBeenCalledTimes(1);
        const [stream, fileName, mimeType, displayName, byteLength] = uploadStreamSpy.mock.calls[0] as [
            ReadableStream,
            string,
            string,
            string,
            number,
        ];
        expect(stream).toBeInstanceOf(ReadableStream);
        expect(fileName).toBe("files/test123");
        expect(mimeType).toBe("image/png");
        expect(displayName).toBe("path.png");
        expect(typeof byteLength).toBe("number");
    });
});

describe("GenaiFileUploader.uploadStream", () => {
    test("returns geminiFileName and geminiUrl when file is immediately ACTIVE", async () => {
        spyOn(GoogleGenAIModule, "uploadStreamSingleRequest").mockImplementation(async () => ACTIVE_FILE);

        const result = await makeUploader().uploadStream(
            new ReadableStream(),
            "files/test123",
            "image/png",
            "test.png",
            512,
        );

        expect(result.geminiFileName).toBe("files/test123");
        expect(result.geminiUrl).toBe(GEMINI_URI);
        expect(mockFilesGet).not.toHaveBeenCalled();
    });

    test("uses single-request path for files at or below 8 MB", async () => {
        const spy = spyOn(GoogleGenAIModule, "uploadStreamSingleRequest").mockImplementation(async () => ACTIVE_FILE);
        const stream = new ReadableStream();

        await makeUploader().uploadStream(stream, "files/my-uuid", "video/mp4", "clip.mp4", CHUNK_SIZE);

        expect(spy).toHaveBeenCalledWith(
            "test-key",
            stream,
            expect.objectContaining({
                name: "files/my-uuid",
                mimeType: "video/mp4",
                displayName: "clip.mp4",
                byteLength: CHUNK_SIZE,
            }),
        );
    });

    test("uses resumable chunked path for files above 8 MB", async () => {
        spyOn(GoogleGenAIModule, "initiateResumableUpload").mockImplementation(
            async () => "https://upload.example.com/session/abc",
        );
        const chunkSpy = spyOn(GoogleGenAIModule, "uploadStreamChunked").mockImplementation(async () => ACTIVE_FILE);

        await makeUploader().uploadStream(new ReadableStream(), "files/big", "video/mp4", "big.mp4", CHUNK_SIZE + 1);

        expect(chunkSpy).toHaveBeenCalled();
    });

    test("throws AppError when file reaches FAILED state", async () => {
        spyOn(GoogleGenAIModule, "uploadStreamSingleRequest").mockImplementation(
            async () => ({ name: "files/test123", state: "FAILED", uri: null }) as unknown as GenaiFile,
        );

        await expect(
            makeUploader().uploadStream(new ReadableStream(), "files/test123", "image/png", "test.png", 512),
        ).rejects.toBeInstanceOf(AppError);
    });

    test("throws AppError when ACTIVE file has no URI", async () => {
        spyOn(GoogleGenAIModule, "uploadStreamSingleRequest").mockImplementation(
            async () => ({ name: "files/test123", state: "ACTIVE", uri: null }) as unknown as GenaiFile,
        );

        await expect(
            makeUploader().uploadStream(new ReadableStream(), "files/test123", "image/png", "test.png", 512),
        ).rejects.toBeInstanceOf(AppError);
    });
});

describe("GenaiFileUploader.deleteFile", () => {
    test("calls ai.files.delete with the provided file name", async () => {
        await makeUploader().deleteFile("files/test123");

        expect(mockFilesDelete).toHaveBeenCalledWith({ name: "files/test123" });
    });

    test("resolves without throwing even when the API throws (file already expired)", async () => {
        mockFilesDelete.mockImplementationOnce(async () => {
            throw new Error("File not found");
        });

        await expect(makeUploader().deleteFile("files/gone")).resolves.toBeUndefined();
    });
});
