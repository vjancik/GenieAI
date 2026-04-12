/**
 * Port interface for downloading Discord file attachments.
 * Placed in the application layer so the use case depends on an abstraction,
 * with the concrete fetch-based implementation living in infrastructure.
 */

import type { IChatClientMessageAttachment } from "./chat/IChatClientMessageMedia.ts";

/** A downloaded attachment ready for use as a LangChain content block. */
export interface DownloadedAttachment {
    /** Base64-encoded file content. */
    data: string;
    /** MIME type resolved from the HTTP response header, falling back to Discord metadata. */
    mimeType: string;
    /** Original filename. */
    name: string;
}

/**
 * Downloads a single Discord attachment and returns it base64-encoded
 * with a resolved MIME type.
 */
export interface IAttachmentDownloader {
    /**
     * @param attachment - Discord attachment metadata including CDN URLs
     * @param acceptTypes - Optional `Accept` header value (e.g. `"image/*"`, `"video/mp4"`).
     *   When provided, sent with the request and validated against the response Content-Type —
     *   triggers fallback to `proxyURL` if the primary URL returns a mismatched type.
     *   Should be supplied whenever the expected MIME type is known (e.g. from a token block).
     */
    download(attachment: IChatClientMessageAttachment, acceptTypes?: string): Promise<DownloadedAttachment>;
}
