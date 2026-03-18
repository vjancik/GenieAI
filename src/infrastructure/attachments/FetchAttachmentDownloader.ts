import * as Sentry from "@sentry/bun";
import type {
    DiscordAttachmentInfo,
    DownloadedAttachment,
    IAttachmentDownloader,
} from "../../application/ports/IAttachmentDownloader.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";

/**
 * Downloads Discord attachments via the native Fetch API.
 *
 * Resolution order for MIME type:
 * 1. HTTP response `Content-Type` header
 * 2. Discord-provided `contentType` metadata
 * 3. `application/octet-stream` (generic binary fallback)
 *
 * Primary URL is attempted first; on failure the proxy URL is tried.
 * Throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both fail.
 */
const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

export class FetchAttachmentDownloader implements IAttachmentDownloader {
    constructor(
        private readonly logger: Logger,
        private readonly responseTimeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS,
    ) {}

    async download(attachment: DiscordAttachmentInfo): Promise<DownloadedAttachment> {
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
                const buffer = await this.fetchWithFallback(attachment);
                const mimeType = buffer.mimeType ?? attachment.contentType ?? "application/octet-stream";

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
        attachment: DiscordAttachmentInfo,
    ): Promise<{ bytes: ArrayBuffer; mimeType: string | null }> {
        // Try primary URL first
        try {
            return await this.fetchUrl(attachment.url);
        } catch (primaryErr) {
            this.logger.warn(
                { err: primaryErr, url: attachment.url, name: attachment.name },
                "Primary attachment URL failed, trying proxy URL",
            );
        }

        // Fall back to proxy URL
        try {
            return await this.fetchUrl(attachment.proxyURL);
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
    private async fetchUrl(url: string): Promise<{ bytes: ArrayBuffer; mimeType: string | null }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.responseTimeoutMs);

        let response: Response;
        try {
            response = await fetch(url, { signal: controller.signal });
        } finally {
            // Clear the timeout whether fetch succeeded or failed — body download must not be interrupted
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            throw new AppError("ATTACHMENT_DOWNLOAD_FAILED", `HTTP ${response.status} fetching attachment from ${url}`);
        }
        const bytes = await response.arrayBuffer();
        // Strip parameters (e.g. "image/jpeg; charset=utf-8") to get the base type
        const rawContentType = response.headers.get("content-type");
        const mimeType = rawContentType?.split(";")[0]?.trim() ?? null;
        return { bytes, mimeType };
    }
}
