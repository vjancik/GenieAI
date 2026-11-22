import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Sentry from "@sentry/bun";
import { file as bunFile, randomUUIDv7 } from "bun";
import { isGeminiNativeMimeType } from "../../application/helpers/geminiMimeType.ts";
import { parseMimeType } from "../../application/helpers/parseMimeType.ts";
import type { IMediaSource, MediaUnavailable, OpenedMedia } from "../../application/ports/IMediaSource.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { WebFetchError } from "../../domain/errors/AppError.ts";
import type { IExternalUrlGuard } from "../http/ExternalUrlGuard.ts";
import { declaredByteLength, isGenericMimeType, resolveFileMimeType, resolveFileName } from "../http/externalFile.ts";
import { IMPIT_PROFILES, type ImpitProfile } from "../http/impitClient.ts";
import { fetchFollowingRedirects, type HopRequest } from "../http/redirects.ts";

/** The part of an HTTP response this source reads. */
interface FileResponse {
    ok: boolean;
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
}

/** The part of an HTTP client this source uses. */
interface FileHttpClient {
    /** Performs a single request; redirects must be returned rather than followed. */
    fetch(url: string, init: HopRequest & { signal: AbortSignal; redirect: "manual" }): Promise<FileResponse>;
}

/**
 * Creates the client for one download attempt. The client must not enforce a deadline on
 * the request as a whole, as a download takes however long its size demands.
 */
type FileHttpClientFactory = (browser: ImpitProfile) => FileHttpClient;

interface ExternalFileSourceOptions {
    /** Files larger than this are not loaded. */
    maxBytes: number;
    /** How long to wait for the response headers before giving up on an attempt (ms). */
    responseTimeoutMs: number;
    /**
     * Checks the URL and every redirect hop against the external content policy, which may
     * have changed since the website tool found the file.
     */
    urlGuard?: IExternalUrlGuard;
}

/**
 * Drops the leading "<url>: " of a fetch error message, which the notice shown in place of
 * the file already names.
 */
function withoutUrlPrefix(message: string, url: string): string {
    const prefix = `${url}: `;
    return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * Wraps a stream so that `cleanup` runs once it is fully read or cancelled.
 */
function withCleanup(source: ReadableStream<Uint8Array>, cleanup: () => Promise<void>): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                await cleanup();
                return;
            }
            controller.enqueue(value);
        },
        async cancel(reason) {
            await reader.cancel(reason);
            await cleanup();
        },
    });
}

/** Deletes a temp file, ignoring that it may already be gone. */
async function removeFile(path: string): Promise<void> {
    await unlink(path).catch(() => undefined);
}

/**
 * Opens files on the web for upload, by their `http(s)://` URL.
 *
 * This is what a file found by the website tool is loaded with, both the first time and
 * whenever its Gemini upload has expired: the web is the only copy there is. A file that has
 * since been removed, replaced by another type, or grown past the size limit is reported as
 * gone rather than as an error, like deleted Discord media.
 *
 * Requests use the same browser impersonation as the website tool, so a host that served the
 * tool serves the download too.
 */
export class ImpitExternalFileSource implements IMediaSource {
    constructor(
        private readonly createClient: FileHttpClientFactory,
        private readonly logger: Logger,
        private readonly options: ExternalFileSourceOptions,
    ) {}

    /**
     * @param url - The file's URL
     * @param expectedMimeType - The type the file had when the website tool found it. Used
     *   when the server does not name a type of its own.
     * @returns The opened file, or why it cannot be loaded (any more)
     */
    async open(url: string, expectedMimeType?: string): Promise<OpenedMedia | MediaUnavailable> {
        return Sentry.startSpan({ name: "Download external file", op: "http.client.download" }, async (span) => {
            let lastError: unknown;

            // A transport-level failure is worth another fingerprint; an answer is final
            for (const profile of IMPIT_PROFILES) {
                try {
                    const opened = await this.openWithProfile(url, profile, expectedMimeType);
                    if ("unavailable" in opened) {
                        this.logger.warn({ url, reason: opened.unavailable }, "External file cannot be loaded");
                        return opened;
                    }
                    span.setAttributes({
                        "attachment.mime_type": opened.mimeType,
                        "attachment.byte_length": opened.byteLength,
                    });
                    this.logger.debug(
                        { url, mimeType: opened.mimeType, byteLength: opened.byteLength },
                        "External file download initiated",
                    );
                    return opened;
                } catch (err) {
                    // A refused URL or redirect is final: another fingerprint changes nothing
                    if (err instanceof WebFetchError) {
                        this.logger.warn({ url, reason: err.reason }, "External file URL refused");
                        return { unavailable: withoutUrlPrefix(err.message, url) };
                    }
                    lastError = err;
                }
            }

            this.logger.warn({ url, err: lastError }, "External file could not be reached");
            return { unavailable: "the server could not be reached" };
        });
    }

    /**
     * Performs one download attempt.
     *
     * Redirects are followed hop by hop, each checked by the URL guard before it is requested.
     *
     * @throws WebFetchError when the URL guard refuses the URL or a redirect hop
     * @throws On a transport-level failure, including a timeout waiting for the headers
     */
    private async openWithProfile(
        url: string,
        profile: ImpitProfile,
        expectedMimeType: string | undefined,
    ): Promise<OpenedMedia | MediaUnavailable> {
        const abortController = new AbortController();
        // Bounds the wait for the final headers only: the body is given the time its size demands
        const timeoutId = setTimeout(() => abortController.abort(), this.options.responseTimeoutMs);

        const client = this.createClient(profile);
        let response: FileResponse;
        let finalUrl: string;
        try {
            ({ response, url: finalUrl } = await fetchFollowingRedirects(
                (hopUrl, request) =>
                    client.fetch(hopUrl, { ...request, signal: abortController.signal, redirect: "manual" }),
                url,
                { method: "GET" },
                this.options.urlGuard,
            ));
        } finally {
            clearTimeout(timeoutId);
        }

        const reject = (reason: string): MediaUnavailable => {
            // Stop the transfer of a body nobody is going to read
            abortController.abort();
            return { unavailable: reason };
        };

        if (!response.ok) return reject(`the server responded with HTTP ${response.status}`);

        const headerMimeType = parseMimeType(response.headers.get("content-type"));
        const mimeType =
            resolveFileMimeType(headerMimeType, finalUrl) ??
            // A server naming no specific type leaves the type the file had before as the best guess
            (expectedMimeType !== undefined &&
            isGeminiNativeMimeType(expectedMimeType) &&
            isGenericMimeType(headerMimeType)
                ? expectedMimeType
                : null);
        if (mimeType === null) return reject(`it is now of an unsupported type ("${headerMimeType ?? "unknown"}")`);

        const name = resolveFileName(response.headers, finalUrl);
        const byteLength = declaredByteLength(response.headers);

        if (byteLength === null) {
            const spooled = await this.spoolToDisk(response.body);
            if (spooled === null) return reject("it is larger than the size limit");
            return { ...spooled, mimeType, name };
        }
        if (byteLength > this.options.maxBytes) return reject("it is larger than the size limit");

        return { stream: response.body, mimeType, byteLength, name };
    }

    /**
     * Writes a body of undeclared size to a temp file, to learn the byte length an upload
     * requires up front without holding the file in memory.
     *
     * @returns A stream over the temp file, which is deleted once the stream is fully read or
     *   cancelled, or `null` when the body exceeds the size limit
     */
    private async spoolToDisk(
        body: ReadableStream<Uint8Array>,
    ): Promise<Pick<OpenedMedia, "stream" | "byteLength"> | null> {
        const path = join(tmpdir(), `genie-external-file-${randomUUIDv7()}`);
        const writer = bunFile(path).writer();
        let byteLength = 0;

        try {
            for await (const chunk of body) {
                byteLength += chunk.byteLength;
                if (byteLength > this.options.maxBytes) {
                    await writer.end();
                    await removeFile(path);
                    return null;
                }
                writer.write(chunk);
            }
            await writer.end();
        } catch (err) {
            await Promise.resolve(writer.end()).catch(() => undefined);
            await removeFile(path);
            throw err;
        }

        return { stream: withCleanup(bunFile(path).stream(), () => removeFile(path)), byteLength };
    }
}
