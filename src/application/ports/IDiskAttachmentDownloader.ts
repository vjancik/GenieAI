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
     * @returns The resolved MIME type (from response Content-Type header,
     *          Discord metadata, or `"application/octet-stream"` as fallback)
     * @throws {@link AppError} with code `ATTACHMENT_DOWNLOAD_FAILED` if both URLs fail
     */
    downloadToFile(
        attachment: DiscordAttachmentInfo,
        destPath: string,
    ): Promise<string>;
}
