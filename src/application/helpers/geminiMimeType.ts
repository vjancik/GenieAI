/**
 * MIME type prefixes that Gemini natively handles as non-text media.
 * Anything outside these prefixes (plus application/pdf) is coerced to
 * text/plain before upload, since Gemini rejects unknown or vendor-specific
 * text-ish MIME types (e.g. text/javascript, application/json, text/html).
 */
const GEMINI_NATIVE_MIME_PREFIXES = ["image/", "audio/", "video/"] as const;

/**
 * Normalizes a MIME type for Gemini file uploads.
 * Non-media, non-PDF types are coerced to `text/plain`.
 */
export function normalizeGeminiMimeType(mimeType: string): string {
    if (mimeType === "application/pdf") return mimeType;
    if (GEMINI_NATIVE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return mimeType;
    return "text/plain";
}
