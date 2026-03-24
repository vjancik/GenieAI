import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import * as Sentry from "@sentry/bun";
import { file as bunFile } from "bun";
import type { AppConfig } from "../../application/config/AppConfig.ts";
import type { IChatClientMessageAttachment } from "../../application/ports/chat/IChatClient.ts";
import type { IDiskAttachmentDownloader } from "../../application/ports/IDiskAttachmentDownloader.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";

/**
 * Downloads Discord attachments to disk by streaming the fetch response body
 * directly to a file, avoiding loading the entire file into memory.
 *
 * Falls back to `proxyURL` if the primary CDN URL fails.
 * Throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both fail.
 *
 * The caller is responsible for deleting the destination file after use.
 */
export class FetchDiskAttachmentDownloader implements IDiskAttachmentDownloader {
    private readonly responseTimeoutMs: number;
    private readonly maxSizeBytes: number;

    constructor(
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
    ) {
        this.responseTimeoutMs = config.file.attachmentDownloader.timeoutMs;
        this.maxSizeBytes = config.file.attachmentDownloader.disk.maxSizeMB * 1024 * 1024;
    }

    async downloadToFile(
        attachment: IChatClientMessageAttachment,
        destPath: string,
        acceptTypes?: string,
    ): Promise<string> {
        return Sentry.startSpan(
            {
                name: "Download Discord attachment to disk",
                op: "http.client.download",
                attributes: {
                    "attachment.name": attachment.name,
                    "attachment.size": attachment.size,
                },
            },
            async (span) => {
                // size > 0 means Discord reported a known size — skip if it already exceeds the limit
                if (attachment.size > 0 && attachment.size > this.maxSizeBytes) {
                    throw new AppError(
                        "ATTACHMENT_TOO_LARGE",
                        `Attachment "${attachment.name}" is ${attachment.size} bytes, exceeding the ${this.maxSizeBytes / 1024 / 1024} MB disk limit`,
                    );
                }

                this.logger.debug(
                    { name: attachment.name, size: attachment.size, destPath },
                    "Downloading attachment to disk",
                );

                // Ensure the destination directory exists
                await mkdir(dirname(destPath), { recursive: true });

                let result: { mimeType: string | null };
                try {
                    result = await this.streamToFile(attachment.url, destPath, acceptTypes);
                } catch (primaryErr) {
                    this.logger.warn(
                        {
                            err: primaryErr,
                            url: attachment.url,
                            name: attachment.name,
                        },
                        "Primary attachment URL failed, trying proxy URL",
                    );
                    try {
                        result = await this.streamToFile(attachment.proxyURL, destPath, acceptTypes);
                    } catch (proxyErr) {
                        throw new AppError(
                            "ATTACHMENT_DOWNLOAD_FAILED",
                            `Failed to download attachment "${attachment.name}" to disk from both primary and proxy URLs`,
                            proxyErr,
                        );
                    }
                }

                const mimeType = result.mimeType ?? attachment.contentType ?? "application/octet-stream";

                span.setAttribute("attachment.mime_type", mimeType);

                this.logger.debug({ name: attachment.name, destPath, mimeType }, "Downloaded attachment to disk");

                return mimeType;
            },
        );
    }

    /**
     * Streams a URL response body to a file on disk.
     * Creates or overwrites the file at `destPath`.
     * Cleans up a partially written file on failure.
     */
    private async streamToFile(
        url: string,
        destPath: string,
        acceptTypes?: string,
    ): Promise<{ mimeType: string | null }> {
        this.logger.debug({ url }, "Fetching attachment URL");

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.responseTimeoutMs);

        const headers: Record<string, string> = {};
        if (acceptTypes !== undefined) headers.Accept = acceptTypes;

        let response: Response;
        try {
            response = await fetch(url, { signal: controller.signal, headers });
        } finally {
            // Clear the timeout once headers arrive — body streaming must not be interrupted
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            throw new AppError("ATTACHMENT_DOWNLOAD_FAILED", `HTTP ${response.status} fetching attachment from ${url}`);
        }

        if (!response.body) {
            throw new AppError("ATTACHMENT_DOWNLOAD_FAILED", `No response body for attachment at ${url}`);
        }

        // If the server advertises a Content-Length, check it before streaming to disk
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader !== null) {
            const contentLength = Number(contentLengthHeader);
            if (!Number.isNaN(contentLength) && contentLength > this.maxSizeBytes) {
                throw new AppError(
                    "ATTACHMENT_TOO_LARGE",
                    `Response Content-Length ${contentLength} bytes from ${url} exceeds the ${this.maxSizeBytes / 1024 / 1024} MB disk limit`,
                );
            }
        }

        const rawContentType = response.headers.get("content-type");
        const mimeType = rawContentType?.split(";")[0]?.trim() ?? null;

        // Validate the response MIME type against the requested Accept types.
        // A wildcard pattern like "image/*" matches any "image/" prefix.
        if (acceptTypes !== undefined && mimeType !== null) {
            const accepted = acceptTypes.split(",").map((t) => t.trim());
            const isAccepted = accepted.some((pattern) => {
                if (pattern.endsWith("/*")) return mimeType.startsWith(pattern.slice(0, -1));
                return mimeType === pattern;
            });
            if (!isAccepted) {
                throw new AppError(
                    "UNEXPECTED_CONTENT_TYPE",
                    `Expected ${acceptTypes} from ${url} but got "${mimeType}"`,
                );
            }
        }

        const contentLength = response.headers.get("content-length");
        this.logger.debug({ mimeType, contentLength, destPath }, "Response received, writing to disk");

        // Write the response body to disk by reading chunks from the stream
        const file = bunFile(destPath);
        const writer = file.writer();
        try {
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // TODO: respect backpressure signal, write returns a promise that resolves when the chunk is flushed to disk
                writer.write(value);
            }
            await writer.end();
        } catch (err) {
            // Clean up a partially written file to avoid leaving garbage on disk
            await Promise.resolve(writer.end()).catch(() => {});
            await unlink(destPath).catch(() => {});
            throw err;
        }

        return { mimeType };
    }
}
