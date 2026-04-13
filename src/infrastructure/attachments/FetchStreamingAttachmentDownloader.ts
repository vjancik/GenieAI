import * as Sentry from "@sentry/bun";
import type { AppConfig } from "../../application/config/AppConfig.ts";
import { parseMimeType } from "../../application/helpers/parseMimeType.ts";
import type { IChatClientMessageAttachment } from "../../application/ports/chat/IChatClient.ts";
import type {
    IStreamingAttachmentDownloader,
    StreamingAttachment,
} from "../../application/ports/IStreamingAttachmentDownloader.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";

/**
 * Downloads Discord attachments as a live `ReadableStream` without buffering the body.
 *
 * Only awaits the response headers — the body stream is returned to the caller
 * for direct piping (e.g. into the Gemini Files resumable upload protocol).
 * Size limits from inline config are intentionally not enforced here.
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
export class FetchStreamingAttachmentDownloader implements IStreamingAttachmentDownloader {
    private readonly responseTimeoutMs: number;

    constructor(
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
    ) {
        this.responseTimeoutMs = config.file.attachmentDownloader.timeoutMs;
    }

    async downloadStream(attachment: IChatClientMessageAttachment, acceptTypes?: string): Promise<StreamingAttachment> {
        return Sentry.startSpan(
            {
                name: "Download Discord attachment (streaming)",
                op: "http.client.download",
                attributes: {
                    "attachment.name": attachment.name,
                    "attachment.size": attachment.size,
                },
            },
            async (span) => {
                // Discord's CDN Content-Type header is unreliable for attachments (e.g. serves image/webp for a png).
                // attachment.contentType from the Discord API is authoritative when present (always set for attachments,
                // null for embeds). For embeds, fall back to the CDN header and enforce acceptTypes against it.
                const result = await this.fetchWithFallback(
                    attachment,
                    attachment.contentType === null ? acceptTypes : undefined,
                );
                const mimeType = parseMimeType(attachment.contentType) ?? result.mimeType ?? "application/octet-stream";

                span.setAttributes({
                    "attachment.mime_type": mimeType,
                    ...(result.byteLength !== null && { "attachment.byte_length": result.byteLength }),
                });

                this.logger.debug(
                    { name: attachment.name, mimeType, byteLength: result.byteLength },
                    "Streaming attachment download initiated",
                );

                return {
                    stream: result.stream,
                    mimeType,
                    byteLength: result.byteLength,
                    name: attachment.name,
                };
            },
        );
    }

    /**
     * Attempts to fetch from the primary URL, falling back to proxyURL on error.
     * Returns the response body stream and header-derived metadata.
     */
    private async fetchWithFallback(
        attachment: IChatClientMessageAttachment,
        acceptTypes?: string,
    ): Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string | null; byteLength: number | null }> {
        try {
            return await this.fetchUrl(attachment.url, acceptTypes);
        } catch (primaryErr) {
            this.logger.warn(
                { err: primaryErr, url: attachment.url, name: attachment.name },
                "Primary attachment URL failed, trying proxy URL",
            );
        }

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
     * Fetches a URL with a timeout that applies only to receiving the initial response headers.
     * Once headers are received the timeout is cleared — the body stream is returned live
     * without interruption.
     */
    private async fetchUrl(
        url: string,
        acceptTypes?: string,
    ): Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string | null; byteLength: number | null }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.responseTimeoutMs);

        const headers: Record<string, string> = {};
        if (acceptTypes !== undefined) headers.Accept = acceptTypes;

        let response: Response;
        try {
            response = await fetch(url, { signal: controller.signal, headers });
        } finally {
            // Clear the timeout once headers are received — body stream must not be interrupted
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            throw new AppError("ATTACHMENT_DOWNLOAD_FAILED", `HTTP ${response.status} fetching attachment from ${url}`);
        }

        const mimeType = parseMimeType(response.headers.get("content-type"));

        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = contentLengthHeader !== null ? Number(contentLengthHeader) : null;
        const byteLength = contentLength !== null && !Number.isNaN(contentLength) ? contentLength : null;

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

        if (response.body === null) {
            throw new AppError("ATTACHMENT_DOWNLOAD_FAILED", `Response body is null for ${url}`);
        }

        return { stream: response.body, mimeType, byteLength };
    }
}
