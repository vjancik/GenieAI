import { file as bunFile } from "bun";
import { isGeminiNativeMimeType } from "../../application/helpers/geminiMimeType.ts";
import { parseMimeType } from "../../application/helpers/parseMimeType.ts";

/** The MIME type servers fall back to when they don't know what they are serving. */
const GENERIC_BINARY_MIME_TYPE = "application/octet-stream";

/** Name given to a file whose URL and headers reveal none. */
const FALLBACK_FILE_NAME = "file";

/** The path of a URL, or null when the URL cannot be parsed. */
function pathOf(url: string): string | null {
    try {
        return decodeURIComponent(new URL(url).pathname);
    } catch {
        return null;
    }
}

/**
 * Determines the MIME type of a file served from the web, as far as the model can read it.
 *
 * The response's Content-Type is trusted when it names a specific type. Servers that answer
 * with the generic binary type (or none at all) are common for downloads, so in that case
 * the type is inferred from the file extension in the URL.
 *
 * @param headerMimeType - The bare media type from the Content-Type header, or null when absent
 * @param url - The final URL of the response, after redirects
 * @returns A type the model reads as a file (PDF, image, audio, video), or null when the
 *   response is of any other type
 */
export function resolveFileMimeType(headerMimeType: string | null, url: string): string | null {
    const isGeneric = headerMimeType === null || headerMimeType === "" || headerMimeType === GENERIC_BINARY_MIME_TYPE;
    if (!isGeneric) return isGeminiNativeMimeType(headerMimeType) ? headerMimeType : null;

    const path = pathOf(url);
    if (path === null) return null;
    // Bun derives the type from the extension alone; the file is never touched
    const inferred = parseMimeType(bunFile(path).type);
    return inferred !== null && isGeminiNativeMimeType(inferred) ? inferred : null;
}

/**
 * Picks a display name for a file served from the web: the name suggested by the
 * Content-Disposition header, else the last segment of the URL path.
 */
export function resolveFileName(headers: Headers, url: string): string {
    const disposition = headers.get("content-disposition");
    // RFC 6266: the extended `filename*` parameter (charset'lang'value) takes precedence
    const extended = disposition?.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)?.[1];
    if (extended !== undefined) {
        try {
            return decodeURIComponent(extended.trim());
        } catch {
            // Malformed percent-encoding: fall through to the plain parameter
        }
    }
    const plain = disposition?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
    const fromHeader = (plain?.[1] ?? plain?.[2])?.trim();
    if (fromHeader) return fromHeader;

    const segment = pathOf(url)?.split("/").filter(Boolean).at(-1);
    return segment ?? FALLBACK_FILE_NAME;
}

/**
 * Reads the size of a response body from its headers.
 *
 * A compressed response is reported as unknown: its Content-Length counts the bytes on the
 * wire, while the body is read decompressed and so comes out larger.
 *
 * @returns The exact number of bytes the body yields, or null when the headers don't tell
 */
export function declaredByteLength(headers: Headers): number | null {
    const encoding = headers.get("content-encoding");
    if (encoding !== null && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity") return null;

    const header = headers.get("content-length");
    if (header === null) return null;
    const length = Number(header);
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
