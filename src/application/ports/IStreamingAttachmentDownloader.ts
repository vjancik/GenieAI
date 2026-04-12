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
     * Falls back to `proxyURL` if the primary `url` fails or returns a mismatched MIME type.
     *
     * @param attachment - Discord attachment metadata including CDN URLs
     * @param acceptTypes - Optional `Accept` header value (e.g. `"image/*"`, `"video/mp4"`).
     *   When provided, sent with the request and validated against the response Content-Type —
     *   triggers fallback to `proxyURL` if the primary URL returns a mismatched type.
     *   Should be supplied whenever the expected MIME type is known (e.g. from a token block).
     * @throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both URLs fail
     */
    downloadStream(attachment: IChatClientMessageAttachment, acceptTypes?: string): Promise<StreamingAttachment>;
}
