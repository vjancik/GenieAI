/**
 * Port interface for downloading Discord file attachments.
 * Placed in the application layer so the use case depends on an abstraction,
 * with the concrete fetch-based implementation living in infrastructure.
 */

/** Metadata Discord provides for a message attachment. */
export interface DiscordAttachmentInfo {
    /** Primary CDN URL for the attachment. */
    url: string;
    /** Proxy URL — used as a fallback if the primary URL fails. */
    proxyURL: string;
    /** Original filename as uploaded by the user. */
    name: string;
    /** File size in bytes as reported by Discord (used for pre-download size checks). */
    size: number;
    /** MIME type as reported by Discord, or null if unavailable. */
    contentType: string | null;
}

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
    download(attachment: DiscordAttachmentInfo): Promise<DownloadedAttachment>;
}
