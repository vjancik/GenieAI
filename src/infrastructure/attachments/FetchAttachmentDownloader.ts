import * as Sentry from "@sentry/bun";
import type { AppConfig } from "../../application/config/AppConfig.ts";
import type { IChatClientMessageAttachment } from "../../application/ports/chat/IChatClient.ts";
import type { DownloadedAttachment, IAttachmentDownloader } from "../../application/ports/IAttachmentDownloader.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";

/**
 * Downloads Discord attachments via the native Fetch API.
 *
 * Resolution order for MIME type:
 * 1. Discord-provided `contentType` metadata (authoritative — Discord's CDN may transcode
 *    and return a different Content-Type header, e.g. image/webp for a PNG attachment)
 * 2. HTTP response `Content-Type` header (fallback for embed media where metadata is null)
 * 3. `application/octet-stream` (generic binary fallback)
 *
 * Primary URL is attempted first; on failure the proxy URL is tried.
 * Throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both fail.
 */
export class FetchAttachmentDownloader implements IAttachmentDownloader {
    private readonly responseTimeoutMs: number;
    private readonly maxSizeBytes: number;

    constructor(
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
    ) {
        this.responseTimeoutMs = config.file.attachmentDownloader.timeoutMs;
        this.maxSizeBytes = config.file.attachmentDownloader.memory.maxSizeMB * 1024 * 1024;
    }

    async download(attachment: IChatClientMessageAttachment, acceptTypes?: string): Promise<DownloadedAttachment> {
        return Sentry.startSpan(
            {
                name: "Download Discord attachment (inline)",
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
                        `Attachment "${attachment.name}" is ${attachment.size} bytes, exceeding the ${this.maxSizeBytes / 1024 / 1024} MB inline limit`,
                    );
                }
                const buffer = await this.fetchWithFallback(attachment, acceptTypes);
                const mimeType = attachment.contentType ?? buffer.mimeType ?? "application/octet-stream";

                span.setAttribute("attachment.mime_type", mimeType);

                const data = Buffer.from(buffer.bytes).toString("base64");

                this.logger.debug(
                    {
                        name: attachment.name,
                        mimeType,
                        bytes: buffer.bytes.byteLength,
                    },
                    "Downloaded attachment",
                );

                return { data, mimeType, name: attachment.name };
            },
        );
    }

    /**
     * Attempts to fetch from the primary URL, falling back to proxyURL on error.
     * Returns the raw bytes and the MIME type from the response Content-Type header.
     */
    private async fetchWithFallback(
        attachment: IChatClientMessageAttachment,
        acceptTypes?: string,
    ): Promise<{ bytes: ArrayBuffer; mimeType: string | null }> {
        // Try primary URL first
        try {
            return await this.fetchUrl(attachment.url, acceptTypes);
        } catch (primaryErr) {
            this.logger.warn(
                { err: primaryErr, url: attachment.url, name: attachment.name },
                "Primary attachment URL failed, trying proxy URL",
            );
        }

        // Fall back to proxy URL
        try {
            return await this.fetchUrl(attachment.proxyURL, acceptTypes);
        } catch (proxyErr) {
            throw new AppError(
                "ATTACHMENT_DOWNLOAD_FAILED",
                `Failed to download attachment "${attachment.name}" from both primary and proxy URLs`,
                proxyErr,
            );
        }
    }

    /**
     * Fetches a URL with a timeout that applies only to receiving the initial response.
     * Once the response headers are received the timeout is cleared, so large body
     * downloads are not interrupted regardless of how long they take.
     */
    private async fetchUrl(
        url: string,
        acceptTypes?: string,
    ): Promise<{ bytes: ArrayBuffer; mimeType: string | null }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.responseTimeoutMs);

        const headers: Record<string, string> = {};
        if (acceptTypes !== undefined) headers.Accept = acceptTypes;

        let response: Response;
        try {
            response = await fetch(url, { signal: controller.signal, headers });
        } finally {
            // Clear the timeout whether fetch succeeded or failed — body download must not be interrupted
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            throw new AppError("ATTACHMENT_DOWNLOAD_FAILED", `HTTP ${response.status} fetching attachment from ${url}`);
        }

        // If the server advertises a Content-Length, check it before buffering the body
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader !== null) {
            const contentLength = Number(contentLengthHeader);
            if (!Number.isNaN(contentLength) && contentLength > this.maxSizeBytes) {
                throw new AppError(
                    "ATTACHMENT_TOO_LARGE",
                    `Response Content-Length ${contentLength} bytes from ${url} exceeds the ${this.maxSizeBytes / 1024 / 1024} MB inline limit`,
                );
            }
        }

        const bytes = await response.arrayBuffer();
        // Strip parameters (e.g. "image/jpeg; charset=utf-8") to get the base type
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

        return { bytes, mimeType };
    }
}
