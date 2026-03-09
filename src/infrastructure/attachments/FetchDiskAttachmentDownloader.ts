import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import * as Sentry from "@sentry/bun";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
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
export class FetchDiskAttachmentDownloader
    implements IDiskAttachmentDownloader
{
    constructor(private readonly logger: Logger) {}

    async downloadToFile(
        attachment: DiscordAttachmentInfo,
        destPath: string,
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
                this.logger.debug(
                    { name: attachment.name, size: attachment.size, destPath },
                    "Downloading attachment to disk",
                );

                // Ensure the destination directory exists
                await mkdir(dirname(destPath), { recursive: true });

                let result: { mimeType: string | null };
                try {
                    result = await this.streamToFile(attachment.url, destPath);
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
                        result = await this.streamToFile(
                            attachment.proxyURL,
                            destPath,
                        );
                    } catch (proxyErr) {
                        throw new AppError(
                            "ATTACHMENT_DOWNLOAD_FAILED",
                            `Failed to download attachment "${attachment.name}" to disk from both primary and proxy URLs`,
                            proxyErr,
                        );
                    }
                }

                const mimeType =
                    result.mimeType ??
                    attachment.contentType ??
                    "application/octet-stream";

                span.setAttribute("attachment.mime_type", mimeType);

                this.logger.debug(
                    { name: attachment.name, destPath, mimeType },
                    "Downloaded attachment to disk",
                );

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
    ): Promise<{ mimeType: string | null }> {
        this.logger.debug({ url }, "Fetching attachment URL");
        const response = await fetch(url);
        if (!response.ok) {
            throw new AppError(
                "ATTACHMENT_DOWNLOAD_FAILED",
                `HTTP ${response.status} fetching attachment from ${url}`,
            );
        }

        if (!response.body) {
            throw new AppError(
                "ATTACHMENT_DOWNLOAD_FAILED",
                `No response body for attachment at ${url}`,
            );
        }

        const rawContentType = response.headers.get("content-type");
        const mimeType = rawContentType?.split(";")[0]?.trim() ?? null;
        const contentLength = response.headers.get("content-length");
        this.logger.debug(
            { mimeType, contentLength, destPath },
            "Response received, writing to disk",
        );

        // Write the response body to disk by reading chunks from the stream
        const file = Bun.file(destPath);
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
