import { beforeEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { AppError } from "../../../src/domain/errors/AppError.ts";

const testLogger = pino({ level: "silent" });

/**
 * Module-level mocks shared by all MockGoogleGenAI instances.
 * Since GenaiFileUploader calls `new GoogleGenAI()` internally, and each instance
 * gets these shared mock functions on `files`, we can control behavior via
 * `mockImplementationOnce` without needing access to the internal instance.
 */
const mockFilesUpload = mock(async () => ({
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
        // All instances share the same mock function references
        readonly files = {
            upload: mockFilesUpload,
            get: mockFilesGet,
            delete: mockFilesDelete,
        };
    },
}));

const { GenaiFileUploader } = await import(
    "../../../src/infrastructure/attachments/GenaiFileUploader.ts"
);

const GEMINI_URI =
    "https://generativelanguage.googleapis.com/v1beta/files/test123";

beforeEach(() => {
    // mockReset clears both call history AND the mockImplementationOnce queue,
    // preventing leftover one-time impls from bleeding across tests.
    mockFilesUpload.mockReset();
    mockFilesGet.mockReset();
    mockFilesDelete.mockReset();
    // Restore default ACTIVE response after reset
    mockFilesUpload.mockImplementation(async () => ({
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
        const uploader = new GenaiFileUploader("test-key", testLogger);

        const result = await uploader.upload(
            "/tmp/test.png",
            "files/test123",
            "image/png",
            "test.png",
        );

        expect(result.geminiFileName).toBe("files/test123");
        expect(result.geminiUrl).toBe(GEMINI_URI);
        // get() should not be called if already ACTIVE after upload
        expect(mockFilesGet).not.toHaveBeenCalled();
    });

    test("calls ai.files.upload with correct parameters", async () => {
        const uploader = new GenaiFileUploader("test-key", testLogger);

        await uploader.upload(
            "/tmp/photo.jpg",
            "files/my-uuid",
            "image/jpeg",
            "photo.jpg",
        );

        expect(mockFilesUpload).toHaveBeenCalledWith({
            file: "/tmp/photo.jpg",
            config: {
                name: "files/my-uuid",
                mimeType: "image/jpeg",
                displayName: "photo.jpg",
            },
        });
    });

    test("throws AppError when file reaches FAILED state", async () => {
        mockFilesUpload.mockImplementationOnce(async () => ({
            name: "files/test123",
            state: "FAILED",
            uri: null as unknown as string,
        }));

        const uploader = new GenaiFileUploader("test-key", testLogger);

        await expect(
            uploader.upload(
                "/tmp/test.png",
                "files/test123",
                "image/png",
                "test.png",
            ),
        ).rejects.toBeInstanceOf(AppError);
    });

    test("throws AppError when ACTIVE file has no URI", async () => {
        mockFilesUpload.mockImplementationOnce(async () => ({
            name: "files/test123",
            state: "ACTIVE",
            uri: null as unknown as string,
        }));

        const uploader = new GenaiFileUploader("test-key", testLogger);

        await expect(
            uploader.upload(
                "/tmp/test.png",
                "files/test123",
                "image/png",
                "test.png",
            ),
        ).rejects.toBeInstanceOf(AppError);
    });
});

describe("GenaiFileUploader.deleteFile", () => {
    test("calls ai.files.delete with the provided file name", async () => {
        const uploader = new GenaiFileUploader("test-key", testLogger);

        await uploader.deleteFile("files/test123");

        expect(mockFilesDelete).toHaveBeenCalledWith({ name: "files/test123" });
    });

    test("resolves without throwing even when the API throws (file already expired)", async () => {
        mockFilesDelete.mockImplementationOnce(async () => {
            throw new Error("File not found");
        });

        const uploader = new GenaiFileUploader("test-key", testLogger);

        // Errors are swallowed — file may have already expired
        await expect(
            uploader.deleteFile("files/gone"),
        ).resolves.toBeUndefined();
    });
});
