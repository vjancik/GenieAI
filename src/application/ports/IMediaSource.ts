/** Media opened for reading: headers were received, the body has not been consumed yet. */
export interface OpenedMedia {
    /** Byte stream of the media. The caller is responsible for consuming or cancelling it. */
    stream: ReadableStream<Uint8Array>;
    mimeType: string;
    /** Exact number of bytes the stream yields, as required by the Gemini resumable upload protocol. */
    byteLength: number;
    /** File name to show for the media. */
    name: string;
}

/** Media that can no longer be opened, with the reason why. */
export interface MediaUnavailable {
    /** Why, phrased to complete "the file could not be loaded: <reason>". */
    unavailable: string;
}

/** Narrows the result of {@link IMediaSource.open}. */
export function isMediaUnavailable(result: OpenedMedia | MediaUnavailable): result is MediaUnavailable {
    return "unavailable" in result;
}

/**
 * Port for opening the media a token URL stands for (see `mediaTokenUrl.ts`).
 *
 * This is what makes an expired Gemini upload recoverable: the token URL kept in the message
 * history is enough to fetch the media from its origin again.
 */
export interface IMediaSource {
    /**
     * Opens the media behind a token URL.
     *
     * @param tokenUrl - A `discord://` token or an external `http(s)://` file URL
     * @param expectedMimeType - The MIME type the media had when it was first seen, when known
     * @returns The opened media, or why it no longer exists or can no longer be used
     */
    open(tokenUrl: string, expectedMimeType?: string): Promise<OpenedMedia | MediaUnavailable>;
}
