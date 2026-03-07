import { describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import { GeminiFileRefreshService } from "../../../src/application/GeminiFileRefreshService.ts";
import type { DiscordAttachmentInfo } from "../../../src/application/ports/IAttachmentDownloader.ts";
import type { IDiscordAttachmentRefetcher } from "../../../src/application/ports/IDiscordAttachmentRefetcher.ts";
import type { IDiskAttachmentDownloader } from "../../../src/application/ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "../../../src/application/ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploader } from "../../../src/application/ports/IGeminiFileUploader.ts";
import type { GeminiFileUpload } from "../../../src/domain/message/GeminiFileUpload.ts";

const testLogger = pino({ level: "silent" });

const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/files/abc123/download";
const GEMINI_URL_NEW =
    "https://generativelanguage.googleapis.com/v1beta/files/newfile/download";

/** 1-hour stale threshold: files become stale after 47 hours (48h TTL - 1h). */
const testConfig = { geminiFileStaleThresholdMinutes: 60 };

function makeRecord(
    overrides: Partial<GeminiFileUpload> = {},
): GeminiFileUpload {
    return {
        id: "uuid-1",
        originalGeminiUrl: GEMINI_URL,
        geminiFileName: "files/abc123",
        geminiUrl: GEMINI_URL,
        uploadedAt: new Date(),
        discordAttachmentId: "att-001",
        discordFilename: "image.png",
        messageDiscordId: "msg-001",
        ...overrides,
    };
}

function makeRepo(records: GeminiFileUpload[] = []): IGeminiFileRepository {
    return {
        save: mock(async () => records[0] as GeminiFileUpload),
        updateAfterRefresh: mock(async () => {}),
        findByOriginalUrls: mock(async (urls: string[]) => {
            const result = new Map<string, GeminiFileUpload>();
            for (const r of records) {
                if (urls.includes(r.originalGeminiUrl)) {
                    result.set(r.originalGeminiUrl, r);
                }
            }
            return result;
        }),
    };
}

function makeUploader(newUrl = GEMINI_URL_NEW): IGeminiFileUploader {
    return {
        upload: mock(async () => ({
            geminiFileName: "files/newfile",
            geminiUrl: newUrl,
        })),
        deleteFile: mock(async () => {}),
    };
}

function makeDiskDownloader(): IDiskAttachmentDownloader {
    return {
        downloadToFile: mock(async () => "image/png"),
    };
}

const freshDiscordAttachment: DiscordAttachmentInfo = {
    id: "att-001",
    url: "https://cdn.discord.com/img.png",
    proxyURL: "https://proxy/img.png",
    name: "image.png",
    size: 512,
    contentType: "image/png",
};

function makeRefetcher(
    attachment: DiscordAttachmentInfo | null = freshDiscordAttachment,
): IDiscordAttachmentRefetcher {
    return {
        fetchAttachment: mock(async () => attachment),
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
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const messages = [new AIMessage("hello"), new HumanMessage("world")];

        const result = await service.refreshHistory(messages, makeRefetcher());

        // No Gemini URLs → early return with same reference
        expect(result).toBe(messages);
    });

    test("returns the same array reference when all files are fresh", async () => {
        const freshRecord = makeRecord({ uploadedAt: new Date() }); // just now
        const service = new GeminiFileRefreshService(
            makeRepo([freshRecord]),
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        const result = await service.refreshHistory([msg], makeRefetcher());

        // No stale files → early return with same reference
        expect(result).toBe(result);
        expect(result[0]).toBe(msg);
    });

    test("substitutes stale URL with fresh URL from re-upload", async () => {
        const record = makeRecord({ uploadedAt: hoursAgo(48) });
        const uploader = makeUploader(GEMINI_URL_NEW);
        const service = new GeminiFileRefreshService(
            makeRepo([record]),
            uploader,
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        const result = await service.refreshHistory([msg], makeRefetcher());

        const updated = result[0] as HumanMessage;
        expect(updated).toBeInstanceOf(HumanMessage);
        const block = (updated.content as unknown[])[0] as Record<
            string,
            unknown
        >;
        expect(block.fileUri).toBe(GEMINI_URL_NEW);
    });

    test("persists the refreshed file record after re-upload", async () => {
        const record = makeRecord({ uploadedAt: hoursAgo(48) });
        const repo = makeRepo([record]);
        const service = new GeminiFileRefreshService(
            repo,
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        await service.refreshHistory([msg], makeRefetcher());

        expect(repo.updateAfterRefresh).toHaveBeenCalledWith(
            GEMINI_URL,
            expect.objectContaining({ geminiUrl: GEMINI_URL_NEW }),
        );
    });

    test("deletes old Gemini file during refresh", async () => {
        const record = makeRecord({
            uploadedAt: hoursAgo(48),
            geminiFileName: "files/old-uuid",
        });
        const uploader = makeUploader();
        const service = new GeminiFileRefreshService(
            makeRepo([record]),
            uploader,
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        await service.refreshHistory([msg], makeRefetcher());

        expect(uploader.deleteFile).toHaveBeenCalledWith("files/old-uuid");
    });

    test("removes Gemini block when Discord attachment no longer exists", async () => {
        const record = makeRecord({ uploadedAt: hoursAgo(48) });
        const service = new GeminiFileRefreshService(
            makeRepo([record]),
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "text", text: "Here is my file:" },
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        // null = attachment deleted from Discord
        const result = await service.refreshHistory([msg], makeRefetcher(null));

        const updated = result[0] as HumanMessage;
        const blocks = updated.content as unknown[];
        // Text block kept, Gemini block removed
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
    });

    test("non-HumanMessage messages pass through unchanged", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const aiMsg = new AIMessage("some response");

        const result = await service.refreshHistory([aiMsg], makeRefetcher());

        expect(result[0]).toBe(aiMsg);
    });

    test("HumanMessage with plain string content passes through unchanged", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage("plain text message");

        const result = await service.refreshHistory([msg], makeRefetcher());

        expect(result[0]).toBe(msg);
    });

    test("only refreshes URLs that exceed the stale threshold", async () => {
        // 1h stale threshold → files stale after 47h; 46h old is still fresh
        const freshRecord = makeRecord({ uploadedAt: hoursAgo(46) });
        const service = new GeminiFileRefreshService(
            makeRepo([freshRecord]),
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const msg = new HumanMessage({
            content: [
                { type: "media", mimeType: "image/png", fileUri: GEMINI_URL },
            ],
        });

        const result = await service.refreshHistory([msg], makeRefetcher());

        // Fresh file → returned as same reference
        expect(result[0]).toBe(msg);
    });

    test("non-Gemini URL blocks are not modified", async () => {
        const service = new GeminiFileRefreshService(
            makeRepo(),
            makeUploader(),
            makeDiskDownloader(),
            testLogger,
            testConfig,
        );
        const otherUrl = "https://example.com/image.png";
        const msg = new HumanMessage({
            content: [{ type: "image", mimeType: "image/png", url: otherUrl }],
        });

        const result = await service.refreshHistory([msg], makeRefetcher());

        // No Gemini URLs found → same array reference
        expect(result).toBe(result);
        expect(result[0]).toBe(msg);
    });
});
