import type { DiscordAttachmentInfo } from "./IAttachmentDownloader.ts";

/**
 * Port interface for streaming a Discord attachment to a file on disk.
 *
 * Unlike {@link IAttachmentDownloader} which returns base64-encoded bytes in
 * memory (suitable for inline mode), this port streams the response body
 * directly to a temp file without buffering the entire content in memory.
 * This is required for upload mode where large files are passed to the
 * Gemini Files API by file path.
 *
 * The caller is responsible for deleting the file after use.
 */
export interface IDiskAttachmentDownloader {
    /**
     * Downloads a Discord attachment to a file at the given path.
     * The destination file is created (or overwritten) at `destPath`.
     *
     * Falls back to `proxyURL` if the primary `url` fails.
     *
     * @param attachment - Discord attachment metadata including CDN URLs
     * @param destPath - Absolute path to write the downloaded file
     * @param acceptTypes - Optional `Accept` header value (e.g. `"image/*"`, `"video/*"`).
     *   When provided, the header is sent with the request and the response Content-Type
     *   is validated against it — throws `UNEXPECTED_CONTENT_TYPE` if it does not match.
     * @returns The resolved MIME type (from response Content-Type header,
     *          Discord metadata, or `"application/octet-stream"` as fallback)
     * @throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both URLs fail
     * @throws {@link AppError} with code `UNEXPECTED_CONTENT_TYPE` if the response MIME type
     *   does not match `acceptTypes`
     */
    downloadToFile(attachment: DiscordAttachmentInfo, destPath: string, acceptTypes?: string): Promise<string>;
}
