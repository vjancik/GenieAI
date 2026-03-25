import type { IChatClientMessageAttachment } from "./chat/IChatClientMessageMedia.ts";

/**
 * The result of initiating a streaming attachment download.
 * Headers have been received but the body has not been buffered.
 */
export interface StreamingAttachment {
    /** Byte stream of the response body — caller is responsible for consuming it. */
    stream: ReadableStream<Uint8Array>;
    /** MIME type resolved from Content-Type header, Discord metadata, or octet-stream fallback. */
    mimeType: string;
    /**
     * Total byte length from the Content-Length response header, or `null` when absent.
     * Required by the Gemini resumable upload protocol — callers should handle the null case.
     */
    byteLength: number | null;
    /** Original filename. */
    name: string;
}

/**
 * Port interface for streaming a Discord attachment directly as a `ReadableStream`,
 * without buffering the body into memory.
 *
 * Unlike {@link IAttachmentDownloader} (base64 in memory) and
 * {@link IDiskAttachmentDownloader} (writes to disk), this port returns the raw
 * response stream so callers can pipe it directly to an upstream API (e.g. the
 * Gemini Files resumable upload protocol).
 *
 * Size limits are not enforced — the caller (e.g. upload pipeline) is responsible
 * for applying its own constraints.
 */
export interface IStreamingAttachmentDownloader {
    /**
     * Initiates a fetch for the attachment, awaits the response headers, and returns
     * the response body as a live `ReadableStream` without buffering.
     *
     * Falls back to `proxyURL` if the primary `url` fails.
     *
     * @param attachment - Discord attachment metadata including CDN URLs
     * @param acceptTypes - Optional `Accept` header value (e.g. `"image/*"`, `"video/*"`).
     *   When provided, the header is sent with the request and the response Content-Type
     *   is validated against it — throws `UNEXPECTED_CONTENT_TYPE` if it does not match.
     * @throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both URLs fail
     * @throws {@link AppError} with code `UNEXPECTED_CONTENT_TYPE` if the response MIME type
     *   does not match `acceptTypes`
     */
    downloadStream(attachment: IChatClientMessageAttachment, acceptTypes?: string): Promise<StreamingAttachment>;
}
