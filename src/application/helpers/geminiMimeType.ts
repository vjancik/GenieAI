/**
 * MIME type prefixes that Gemini natively handles as non-text media.
 * Anything outside these prefixes (plus application/pdf) is coerced to
 * text/plain before upload, since Gemini rejects unknown or vendor-specific
 * text-ish MIME types (e.g. text/javascript, application/json, text/html).
 */
const GEMINI_NATIVE_MIME_PREFIXES = ["image/", "audio/", "video/"] as const;

/**
 * Whether Gemini reads the MIME type as a file in its own right (PDF, image, audio, video),
 * as opposed to the textual types it only accepts as `text/plain`.
 */
export function isGeminiNativeMimeType(mimeType: string): boolean {
    if (mimeType === "application/pdf") return true;
    return GEMINI_NATIVE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Normalizes a MIME type for Gemini file uploads.
 * Non-media, non-PDF types are coerced to `text/plain`.
 */
export function normalizeGeminiMimeType(mimeType: string): string {
    return isGeminiNativeMimeType(mimeType) ? mimeType : "text/plain";
}
