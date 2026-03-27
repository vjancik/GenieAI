import { describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import type { IChatClientMessageAttachment } from "../../../src/application/ports/chat/IChatClient.ts";
import type { IDiscordMediaService } from "../../../src/application/ports/IDiscordMediaService.ts";
import type { IGeminiFileRepository } from "../../../src/application/ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploader } from "../../../src/application/ports/IGeminiFileUploader.ts";
import type { IGeminiFileUploaderRegistry } from "../../../src/application/ports/IGeminiFileUploaderRegistry.ts";
import type { IStreamingAttachmentDownloader } from "../../../src/application/ports/IStreamingAttachmentDownloader.ts";
import { GeminiMediaNormalizer } from "../../../src/application/services/GeminiMediaNormalizer.ts";
import type { GeminiFile } from "../../../src/domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../../src/domain/message/GeminiFileUpload.ts";
import type { IMessageRepository } from "../../../src/domain/message/IMessageRepository.ts";

const testLogger = pino({ level: "silent" });

/** Discord token URL for a test attachment — stable lookup key in gemini_files.original_gemini_url. */
const TOKEN_URL = "discord://guild-001/chan-001/msg-001/att-001";
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
            timeoutMs: 10_000,
            memory: { maxSizeMB: 100 },
        },
        globalModelTimeoutMs: 600_000,
        geminiFileApi: {
            pollIntervalMs: 5_000,
            maxPollWaitMs: 120_000,
            fileStaleBeforeExpiryMinutes: 60,
            fileStaleBeforeExpiryMs: 60 * 60 * 1000,
        },
        discord: { chainLimit: 100, retries: 3, enableInDMs: false },
        geminiModels: { includeThoughts: false },
        agent: {
            uploadAttachmentMode: "upload" as const,
            maxInlineAttachmentSizeMB: 100,
            maxInlineAttachmentSizeBytes: 100 * 1024 * 1024,
            nodes: {
                triage: {
                    model: "gemini-test",
                    timeoutMs: 60_000,
                    thinkingLevel: "LOW" as const,
                    apiKeyType: "free" as const,
                },
                general: { model: "gemini-test", timeoutMs: 120_000, apiKeyType: "free" as const },
                search: {
                    model: "gemini-test",
                    timeoutMs: 120_000,
                    mode: "google" as const,
                    apiKeyType: "paid" as const,
                },
            },
        },
        ytDlp: { retries: 1 },
        cache: { geminiFileUrls: 1000 },
        prompts: { basePrompt: "You are an AI assistant." },
    },
};

/** Creates a GeminiFile permanent anchor for tests. */
function makeFile(overrides: Partial<GeminiFile> = {}): GeminiFile {
    return {
        id: "file-uuid-1",
        originalGeminiUrl: TOKEN_URL,
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
 * Mock IGeminiFileRepository. findWithUploadStateForKey returns { byAnchorUrl, byGeminiUrl }
 * maps built from the provided entries, filtered to those whose originalGeminiUrl appears in
 * tokenUrls (byAnchorUrl) or whose upload.geminiUrl appears in geminiUrls (byGeminiUrl).
 */
function makeRepo(entries: RepoEntry[] = []): IGeminiFileRepository {
    return {
        findByOriginalUrl: mock(async (originalUrls: string[], _apiKeyId: string) => {
            const result = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();
            for (const entry of entries) {
                if (originalUrls.includes(entry.file.originalGeminiUrl)) {
                    result.set(entry.file.originalGeminiUrl, entry);
                }
            }
            return result;
        }),
        findByUploadUrl: mock(async (geminiUrls: string[], _apiKeyId: string) => {
            const result = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();
            for (const entry of entries) {
                if (entry.upload !== null && geminiUrls.includes(entry.upload.geminiUrl)) {
                    result.set(entry.upload.geminiUrl, entry);
                }
            }
            return result;
        }),
        saveFiles: mock(async (records: Omit<GeminiFile, "id" | "discordMessageId" | "discordChannelId">[]) =>
            records.map((_r, i) => ({ id: `file-uuid-${i + 1}` })),
        ),
        upsertUpload: mock(async () => undefined),
        upsertUploads: mock(async () => undefined),
    };
}

function makeMessageRepo(messageId: string | null = "msg-uuid-1"): IMessageRepository {
    return {
        getIdByDiscordMessageId: mock(async () => messageId),
    } as unknown as IMessageRepository;
}

/** Mock IGeminiFileUploader that returns a configurable new Gemini URL on upload. */
function makeUploader(newUrl = GEMINI_URL_NEW): IGeminiFileUploader {
    return {
        apiKeyId: TEST_API_KEY_ID,
        upload: mock(async () => ({
            geminiFileName: "files/newfile",
            geminiUrl: newUrl,
        })),
        uploadStream: mock(async () => ({
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

function makeStreamingDownloader(): IStreamingAttachmentDownloader {
    return {
        downloadStream: mock(async () => ({
            stream: new ReadableStream(),
            mimeType: "image/png",
            byteLength: 1024,
            name: "test.png",
        })),
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

function makeMediaService(
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

/** A HumanMessage with a single discord:// token URL media block. */
function makeTokenMsg(tokenUrl = TOKEN_URL): HumanMessage {
    return new HumanMessage({
        content: [{ type: "media", mimeType: "image/png", url: tokenUrl }],
    });
}

describe("GeminiMediaNormalizer.normalize", () => {
    test("returns the same array reference when no token URL blocks are present", async () => {
        const normalizer = new GeminiMediaNormalizer(
            makeRepo(),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const messages = [new AIMessage("hello"), new HumanMessage("world")];

        const result = await normalizer.normalize(messages, TEST_API_KEY_ID);

        expect(result).toBe(messages);
    });

    test("resolves a fresh upload: replaces token URL block with fileUri block", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: new Date(), geminiUrl: GEMINI_URL });
        const normalizer = new GeminiMediaNormalizer(
            makeRepo([{ file, upload }]),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const msg = makeTokenMsg();

        const result = await normalizer.normalize([msg], TEST_API_KEY_ID);

        const updated = result[0] as HumanMessage;
        expect(updated).toBeInstanceOf(HumanMessage);
        const block = (updated.content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL);
        expect(block.url).toBeUndefined();
    });

    test("re-uploads stale file and replaces token URL with new fileUri", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48) });
        const uploader = makeUploader(GEMINI_URL_NEW);
        const normalizer = new GeminiMediaNormalizer(
            makeRepo([{ file, upload }]),
            makeMessageRepo(),
            makeRegistry(uploader),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const msg = makeTokenMsg();

        const result = await normalizer.normalize([msg], TEST_API_KEY_ID);

        const updated = result[0] as HumanMessage;
        const block = (updated.content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL_NEW);
    });

    test("persists refreshed upload record via upsertUpload after re-upload", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48) });
        const repo = makeRepo([{ file, upload }]);
        const normalizer = new GeminiMediaNormalizer(
            repo,
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );

        await normalizer.normalize([makeTokenMsg()], TEST_API_KEY_ID);

        expect(repo.upsertUpload).toHaveBeenCalledWith(
            expect.objectContaining({
                geminiUrl: GEMINI_URL_NEW,
                apiKeyId: TEST_API_KEY_ID,
                geminiFileId: file.id,
            }),
        );
    });

    test("deletes old Gemini file during stale re-upload", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48), geminiFileName: "files/old-uuid" });
        const uploader = makeUploader();
        const normalizer = new GeminiMediaNormalizer(
            makeRepo([{ file, upload }]),
            makeMessageRepo(),
            makeRegistry(uploader),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );

        await normalizer.normalize([makeTokenMsg()], TEST_API_KEY_ID);

        expect(uploader.deleteFile).toHaveBeenCalledWith("files/old-uuid");
    });

    test("drops token block when Discord attachment no longer exists (stale re-upload)", async () => {
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(48) });
        const normalizer = new GeminiMediaNormalizer(
            makeRepo([{ file, upload }]),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(null),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "text", text: "Here is my file:" },
                { type: "media", mimeType: "image/png", url: TOKEN_URL },
            ],
        });

        const result = await normalizer.normalize([msg], TEST_API_KEY_ID);

        const updated = result[0] as HumanMessage;
        const blocks = updated.content as unknown[];
        // Text block kept, media block removed
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
    });

    test("re-uploads file missing for current key (upload === null in LEFT JOIN)", async () => {
        // upload: null → anchor exists but no upload record for this key (new key / trigger-cleaned)
        const file = makeFile();
        const repo = makeRepo([{ file, upload: null }]);
        const uploader = makeUploader(GEMINI_URL_NEW);
        const normalizer = new GeminiMediaNormalizer(
            repo,
            makeMessageRepo(),
            makeRegistry(uploader),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );

        const result = await normalizer.normalize([makeTokenMsg()], TEST_API_KEY_ID);

        const block = ((result[0] as HumanMessage).content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL_NEW);

        // Old file should NOT be deleted (no prior upload for this key)
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

    test("uploads a brand-new file (no DB anchor) and persists anchor + upload record", async () => {
        // makeRepo with no entries → findWithUploadStateForKey returns empty Map
        const repo = makeRepo();
        const uploader = makeUploader(GEMINI_URL_NEW);
        const normalizer = new GeminiMediaNormalizer(
            repo,
            makeMessageRepo(),
            makeRegistry(uploader),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );

        const result = await normalizer.normalize([makeTokenMsg()], TEST_API_KEY_ID);

        const block = ((result[0] as HumanMessage).content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL_NEW);
        expect(repo.saveFiles).toHaveBeenCalled();
        expect(repo.upsertUpload).toHaveBeenCalledWith(
            expect.objectContaining({ apiKeyId: TEST_API_KEY_ID, geminiUrl: GEMINI_URL_NEW }),
        );
    });

    test("still returns uploaded fileUri when message row not found (no anchor persisted)", async () => {
        const repo = makeRepo();
        const uploader = makeUploader(GEMINI_URL_NEW);
        const normalizer = new GeminiMediaNormalizer(
            repo,
            makeMessageRepo(null), // no message row → can't satisfy FK, skip anchor insert
            makeRegistry(uploader),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );

        const result = await normalizer.normalize([makeTokenMsg()], TEST_API_KEY_ID);

        const block = ((result[0] as HumanMessage).content as unknown[])[0] as Record<string, unknown>;
        // fileUri still resolved — request succeeds even without anchor persistence
        expect(block.fileUri).toBe(GEMINI_URL_NEW);
        // anchor should NOT have been saved
        expect(repo.saveFiles).not.toHaveBeenCalled();
    });

    test("non-HumanMessage messages pass through unchanged", async () => {
        const normalizer = new GeminiMediaNormalizer(
            makeRepo(),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const aiMsg = new AIMessage("some response");

        const result = await normalizer.normalize([aiMsg], TEST_API_KEY_ID);

        expect(result[0]).toBe(aiMsg);
    });

    test("HumanMessage with plain string content passes through unchanged", async () => {
        const normalizer = new GeminiMediaNormalizer(
            makeRepo(),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage("plain text message");

        const result = await normalizer.normalize([msg], TEST_API_KEY_ID);

        expect(result[0]).toBe(msg);
    });

    test("only refreshes uploads that exceed the stale threshold", async () => {
        // 46h old: 46h < 47h (staleThresholdMs) → still fresh, no refresh
        const file = makeFile();
        const upload = makeUpload({ uploadedAt: hoursAgo(46), geminiUrl: GEMINI_URL });
        const normalizer = new GeminiMediaNormalizer(
            makeRepo([{ file, upload }]),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const msg = makeTokenMsg();

        const result = await normalizer.normalize([msg], TEST_API_KEY_ID);

        // Fresh file → same fileUri, returned as new message with fileUri (not same ref, but correct URL)
        const block = ((result[0] as HumanMessage).content as unknown[])[0] as Record<string, unknown>;
        expect(block.fileUri).toBe(GEMINI_URL);
    });

    test("non-token URL blocks (e.g. legacy fileUri blocks) are not modified", async () => {
        const normalizer = new GeminiMediaNormalizer(
            makeRepo(),
            makeMessageRepo(),
            makeRegistry(makeUploader()),
            makeStreamingDownloader(),
            makeMediaService(),
            testLogger,
            testConfig,
        );
        const legacyUrl = "https://generativelanguage.googleapis.com/v1beta/files/legacy";
        const msg = new HumanMessage({
            content: [{ type: "media", mimeType: "image/png", fileUri: legacyUrl }],
        });

        const result = await normalizer.normalize([msg], TEST_API_KEY_ID);

        // No token URLs found → same array reference
        expect(result[0]).toBe(msg);
    });
});
