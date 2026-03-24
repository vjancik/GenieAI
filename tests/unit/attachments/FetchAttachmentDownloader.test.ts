import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import pino from "pino";
import type { AppConfig } from "../../../src/application/config/AppConfig.ts";
import type { IChatClientMessageAttachment } from "../../../src/application/ports/chat/IChatClientMessageMedia.ts";
import { AppError } from "../../../src/domain/errors/AppError.ts";
import { FetchAttachmentDownloader } from "../../../src/infrastructure/attachments/FetchAttachmentDownloader.ts";

function makeConfig(timeoutMs: number, maxSizeMB = 100): Pick<AppConfig, "file"> {
    return {
        file: { attachmentDownloader: { timeoutMs, memory: { maxSizeMB }, disk: { maxSizeMB: 1_000 } } },
    } as Pick<AppConfig, "file">;
}

const testLogger = pino({ level: "silent" });

const testAttachment: IChatClientMessageAttachment = {
    id: "att-123",
    url: "https://cdn.discordapp.com/attachments/test/image.jpg",
    proxyURL: "https://media.discordapp.net/attachments/test/image.jpg",
    name: "image.jpg",
    size: 1024,
    contentType: "image/jpeg",
};

/** Creates a minimal Response-like object for fetch mocking. */
function makeResponse(body: Uint8Array, contentType: string | null, ok = true, status = 200): Response {
    const headers = new Headers();
    if (contentType) headers.set("content-type", contentType);
    return {
        ok,
        status,
        headers,
        arrayBuffer: async () => body.buffer as ArrayBuffer,
    } as unknown as Response;
}

describe("FetchAttachmentDownloader", () => {
    let downloader: FetchAttachmentDownloader;

    beforeEach(() => {
        downloader = new FetchAttachmentDownloader(testLogger, makeConfig(10_000));
    });

    test("downloads and base64-encodes content from primary URL", async () => {
        const data = new Uint8Array([1, 2, 3, 4]);
        const globalFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse(data, "image/jpeg"));

        const result = await downloader.download(testAttachment);

        expect(globalFetch).toHaveBeenCalledWith(
            testAttachment.url,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(result.name).toBe("image.jpg");
        expect(result.mimeType).toBe("image/jpeg");
        // base64 of [1,2,3,4]
        expect(result.data).toBe(Buffer.from(data).toString("base64"));

        globalFetch.mockRestore();
    });

    test("resolves mimeType from Content-Type header", async () => {
        const globalFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(
            makeResponse(new Uint8Array([0]), "image/png; charset=utf-8"),
        );

        const result = await downloader.download({
            ...testAttachment,
            contentType: "image/jpeg", // should be overridden by header
        });

        // Header value stripped of parameters
        expect(result.mimeType).toBe("image/png");

        globalFetch.mockRestore();
    });

    test("falls back to Discord contentType when no Content-Type header", async () => {
        const globalFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse(new Uint8Array([0]), null));

        const result = await downloader.download({
            ...testAttachment,
            contentType: "image/gif",
        });

        expect(result.mimeType).toBe("image/gif");

        globalFetch.mockRestore();
    });

    test("falls back to application/octet-stream when no header and no Discord contentType", async () => {
        const globalFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse(new Uint8Array([0]), null));

        const result = await downloader.download({
            ...testAttachment,
            contentType: null,
        });

        expect(result.mimeType).toBe("application/octet-stream");

        globalFetch.mockRestore();
    });

    test("falls back to proxyURL when primary URL fails with non-ok response", async () => {
        const data = new Uint8Array([9, 8]);
        const globalFetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(makeResponse(new Uint8Array(), null, false, 403))
            .mockResolvedValueOnce(makeResponse(data, "image/jpeg"));

        const result = await downloader.download(testAttachment);

        expect(result.data).toBe(Buffer.from(data).toString("base64"));
        expect(globalFetch).toHaveBeenCalledTimes(2);
        expect((globalFetch.mock.calls[1] as string[])[0]).toBe(testAttachment.proxyURL);

        globalFetch.mockRestore();
    });

    test("falls back to proxyURL when primary URL throws", async () => {
        const data = new Uint8Array([5]);
        const globalFetch = spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(new Error("network error"))
            .mockResolvedValueOnce(makeResponse(data, "image/jpeg"));

        const result = await downloader.download(testAttachment);

        expect(result.data).toBe(Buffer.from(data).toString("base64"));

        globalFetch.mockRestore();
    });

    test("throws AppError when both primary and proxy URLs fail", async () => {
        const globalFetch = spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(new Error("primary fail"))
            .mockRejectedValueOnce(new Error("proxy fail"));

        await expect(downloader.download(testAttachment)).rejects.toThrow(AppError);

        globalFetch.mockRestore();
    });

    test("throws AppError when both URLs return non-ok responses", async () => {
        const globalFetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(makeResponse(new Uint8Array(), null, false, 404))
            .mockResolvedValueOnce(makeResponse(new Uint8Array(), null, false, 500));

        await expect(downloader.download(testAttachment)).rejects.toThrow(AppError);

        globalFetch.mockRestore();
    });

    test("aborts fetch when response timeout is exceeded", async () => {
        // Use a 1 ms timeout so the signal is aborted before the fetch resolves
        const timedOutDownloader = new FetchAttachmentDownloader(testLogger, makeConfig(1));

        const globalFetch = spyOn(globalThis, "fetch").mockImplementation(
            // TYPE COERCION: mock only needs to satisfy the Promise<Response> return; full fetch signature not needed
            ((_url: string, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    // Propagate abort from the signal so it rejects as expected
                    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
                })) as typeof fetch,
        );

        await expect(timedOutDownloader.download(testAttachment)).rejects.toThrow(AppError);

        globalFetch.mockRestore();
    });

    test("does not abort body download after response is received", async () => {
        // Use a 1 ms timeout — body download must still succeed after timeout fires
        const timedOutDownloader = new FetchAttachmentDownloader(testLogger, makeConfig(1));
        const data = new Uint8Array([7, 8, 9]);

        const globalFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse(data, "image/png"));

        // Wait long enough for the 1 ms timeout to fire before the response resolves
        await new Promise((r) => setTimeout(r, 5));

        const result = await timedOutDownloader.download(testAttachment);

        expect(result.mimeType).toBe("image/png");
        expect(result.data).toBe(Buffer.from(data).toString("base64"));

        globalFetch.mockRestore();
    });
});
