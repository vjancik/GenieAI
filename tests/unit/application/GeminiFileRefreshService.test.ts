import { describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import type { IChatClientMessageAttachment } from "../../../src/application/ports/chat/IChatClientMessageMedia.ts";
import type { IDiscordMediaService } from "../../../src/application/ports/IDiscordMediaService.ts";
import type { IDiskAttachmentDownloader } from "../../../src/application/ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "../../../src/application/ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploader } from "../../../src/application/ports/IGeminiFileUploader.ts";
import type { IGeminiFileUploaderRegistry } from "../../../src/application/ports/IGeminiFileUploaderRegistry.ts";
import { GeminiFileRefreshService } from "../../../src/application/services/GeminiFileRefreshService.ts";
import type { GeminiFile } from "../../../src/domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../../src/domain/message/GeminiFileUpload.ts";

const testLogger = pino({ level: "silent" });

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/files/abc123";
const GEMINI_URL_NEW = "https://generativelanguage.googleapis.com/v1beta/files/newfile";

/** The API key ID used across all tests. */
const TEST_API_KEY_ID = "test-key-uuid";

/**
 * 1-hour stale threshold: staleThresholdMs = 48h - 60min = 47h.
 * A file is stale when `now - uploadedAt >= 47h`.
 */
const testConfig = {
    file: {
        attachmentDownloader: {
            tempDir: "/var/tmp/genie-attachments",
            timeoutMs: 10_000,
            memory: { maxSizeMB: 100 },
            disk: { maxSizeMB: 1_000 },
        },
        globalModelTimeoutMs: 600_000,
        geminiFileApi: {
            pollIntervalMs: 5_000,
            maxPollWaitMs: 120_000,
            fileStaleBeforeExpiryMinutes: 60,
            fileStaleBeforeExpiryMs: 60 * 60 * 1000,
        },
        discord: { defaultChainLimit: 100, defaultRetriesLeft: 3 },
        geminiModels: { includeThoughts: false },
        agent: {
            uploadAttachmentMode: "upload" as const,
            maxInlineAttachmentSizeMB: 100,
            maxInlineAttachmentSizeBytes: 100 * 1024 * 1024,
            nodes: {
                triage: { model: "gemini-test", timeoutMs: 60_000, thinkingLevel: "LOW" as const },
                general: { model: "gemini-test", timeoutMs: 120_000 },
                search: { model: "gemini-test", timeoutMs: 120_000, mode: "google" as const },
            },
        },
        ytDlp: { retries: 1 },
    },
};

/** Creates a GeminiFile permanent anchor for tests. */
function makeFile(overrides: Partial<GeminiFile> = {}): GeminiFile {
    return {
        id: "file-uuid-1",
        originalGeminiUrl: GEMINI_URL,
        sourceType: "attachment",
        discordAttachmentId: "att-001",
        discordFilename: "image.png",
        embedIndex: null,
        embedMediaKey: null,
        messageId: "msg-uuid-1",
        discordMessageId: "msg-001",
        discordChannelId: "chan-001",
        ...overrides,
    };
}

/** Creates a GeminiFileUpload ephemeral per-key record for tests. */
function makeUpload(overrides: Partial<GeminiFileUpload> = {}): GeminiFileUpload {
    return {
        id: "upload-uuid-1",
        geminiFileId: "file-uuid-1",
        apiKeyId: TEST_API_KEY_ID,
        geminiFileName: "files/abc123",
        geminiUrl: GEMINI_URL,
        uploadedAt: new Date(),
        ...overrides,
    };
}

/** Entry type for makeRepo: a GeminiFile with its optional upload for the test key. */
type RepoEntry = { file: GeminiFile; upload: GeminiFileUpload | null };

/**
 * Mock IGeminiFileRepository. findWithUploadStateForKey returns a Map built
 * from the provided entries, filtered to those whose originalGeminiUrl appears
 * in the requested URLs list.
 */
function makeRepo(entries: RepoEntry[] = []): IGeminiFileRepository {
    return {
        findWithUploadStateForKey: mock(async (urls: string[], _apiKeyId: string) => {
            const result = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();
            for (const entry of entries) {
                if (urls.includes(entry.file.originalGeminiUrl)) {
                    result.set(entry.file.originalGeminiUrl, entry);
                }
            }
            return result;
        }),
        saveFiles: mock(async (records: Omit<GeminiFile, "id">[]) =>
            records.map((_r, i) => ({ id: `file-uuid-${i + 1}` })),
        ),
        upsertUpload: mock(async () => undefined),
        upsertUploads: mock(async () => undefined),
    };
}

/** Mock IGeminiFileUploader that returns a configurable new Gemini URL on upload. */
function makeUploader(newUrl = GEMINI_URL_NEW): IGeminiFileUploader {
    return {
        apiKeyId: TEST_API_KEY_ID,
        upload: mock(async () => ({
            geminiFileName: "files/newfile",
            geminiUrl: newUrl,
        })),
        deleteFile: mock(async () => {}),
    };
}

/**
 * Wraps an IGeminiFileUploader in a minimal IGeminiFileUploaderRegistry.
 * `get()` always returns the same uploader regardless of apiKeyId.
 */
function makeRegistry(uploader: IGeminiFileUploader): IGeminiFileUploaderRegistry {
    return {
        get: mock((_apiKeyId: string) => uploader),
    };
}

function makeDiskDownloader(): IDiskAttachmentDownloader {
    return {
        downloadToFile: mock(async () => "image/png"),
    };
}

const freshDiscordAttachment: IChatClientMessageAttachment = {
    id: "att-001",
    url: "https://cdn.discord.com/img.png",
    proxyURL: "https://proxy/img.png",
    name: "image.png",
    size: 512,
    contentType: "image/png",
};

function makeAttachmentFetcher(
    attachment: IChatClientMessageAttachment | null = freshDiscordAttachment,
): IDiscordMediaService {
    return {
        fetchAttachment: mock(async () => attachment),
        fetchEmbedMedia: mock(async () => attachment),
    };
}

/** Returns a Date representing a timestamp that is `hours` hours in the past. */
function hoursAgo(hours: number): Date {
    return new Date(Date.now() - hours * 60 * 60 * 1000);
}

describe("GeminiFileRefreshService.refreshHistory", () => {
    test("returns the same array reference when no Gemini URLs present", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const messages = [new AIMessage("hello"), new HumanMessage("world")];

        const result = await service.refreshHistory(messages, TEST_API_KEY_ID);

        // No Gemini URLs → early return with same reference
        expect(result).toBe(messages);
    });

    test("returns the same array reference when all files are fresh", async () => {
        // Fresh upload: uploaded just now, geminiUrl === originalGeminiUrl → no substitution
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: new Date() });
        const service = new GeminiFileRefreshService(
            makeRepo([{ file, upload }]),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: GEMINI_URL }],
        });

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        // No stale files → no substitutions → same array reference
        expect(result[0]).toBe(msg);
    });

    test("substitutes stale URL with fresh URL from re-upload", async () => {
        // Upload older than 47h (staleThresholdMs) is considered stale
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48) });
        const uploader = makeUploader(GEMINI_URL_NEW);
        const service = new GeminiFileRefreshService(
            makeRepo([{ file, upload }]),
            makeRegistry(uploader),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: GEMINI_URL }],
        });

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        const updated = result[0] as HumanMessage;
        expect(updated).toBeInstanceOf(HumanMessage);
        const block = (updated.content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL_NEW);
    });

    test("persists the refreshed upload record via upsertUpload after re-upload", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48) });
        const repo = makeRepo([{ file, upload }]);
        const service = new GeminiFileRefreshService(
            repo,
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: GEMINI_URL }],
        });

        await service.refreshHistory([msg], TEST_API_KEY_ID);

        expect(repo.upsertUpload).toHaveBeenCalledWith(
            expect.objectContaining({
                geminiUrl: GEMINI_URL_NEW,
                apiKeyId: TEST_API_KEY_ID,
                geminiFileId: file.id,
            }),
        );
    });

    test("deletes old Gemini file during refresh", async () => {
        const file = makeFile();
        const upload = makeUpload({
            uploadedAt: hoursAgo(48),
            geminiFileName: "files/old-uuid",
        });
        const uploader = makeUploader();
        const service = new GeminiFileRefreshService(
            makeRepo([{ file, upload }]),
            makeRegistry(uploader),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: GEMINI_URL }],
        });

        await service.refreshHistory([msg], TEST_API_KEY_ID);

        expect(uploader.deleteFile).toHaveBeenCalledWith("files/old-uuid");
    });

    test("removes Gemini block when Discord attachment no longer exists", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48) });
        // null = attachment deleted from Discord
        const service = new GeminiFileRefreshService(
            makeRepo([{ file, upload }]),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(null),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "text", text: "Here is my file:" },
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        const updated = result[0] as HumanMessage;
        const blocks = updated.content as unknown[];
        // Text block kept, Gemini block removed
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
    });

    test("re-uploads file missing for current key (upload === null in LEFT JOIN)", async () => {
        // upload: null simulates a key that has never uploaded this file (new key or trigger-cleaned)
        const file = makeFile();
        const repo = makeRepo([{ file, upload: null }]);
        const uploader = makeUploader(GEMINI_URL_NEW);
        const service = new GeminiFileRefreshService(
            repo,
            makeRegistry(uploader),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: GEMINI_URL }],
        });

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        // URL should be replaced with the newly uploaded file's URL
        const updated = result[0] as HumanMessage;
        const block = (updated.content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL_NEW);

        // Old file should NOT be deleted (there is no prior upload for this key)
        expect(uploader.deleteFile).not.toHaveBeenCalled();

        // New upload should be persisted
        expect(repo.upsertUpload).toHaveBeenCalledWith(
            expect.objectContaining({
                geminiFileId: file.id,
                apiKeyId: TEST_API_KEY_ID,
                geminiUrl: GEMINI_URL_NEW,
            }),
        );
    });

    test("non-HumanMessage messages pass through unchanged", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const aiMsg = new AIMessage("some response");

        const result = await service.refreshHistory([aiMsg], TEST_API_KEY_ID);

        expect(result[0]).toBe(aiMsg);
    });

    test("HumanMessage with plain string content passes through unchanged", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage("plain text message");

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        expect(result[0]).toBe(msg);
    });

    test("only refreshes URLs that exceed the stale threshold", async () => {
        // 46h old: 46h < 47h (staleThresholdMs) → still fresh, no refresh
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(46) });
        const service = new GeminiFileRefreshService(
            makeRepo([{ file, upload }]),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: GEMINI_URL }],
        });

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        // Fresh file → returned as same reference (no substitution)
        expect(result[0]).toBe(msg);
    });

    test("non-Gemini URL blocks are not modified", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeRegistry(makeUploader()),
            makeDiskDownloader(),
            makeAttachmentFetcher(),
            testLogger,
            testConfig,
        );
        const otherUrl = "https://example.com/image.png";
        const msg = new HumanMessage({
            content: [{ type: "image", mimeType: "image/png", url: otherUrl }],
        });

        const result = await service.refreshHistory([msg], TEST_API_KEY_ID);

        // No Gemini URLs found → same array reference
        expect(result[0]).toBe(msg);
    });
});
