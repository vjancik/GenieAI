/**
 * Strips parameters from a Content-Type header value, returning only the media type.
 *
 * e.g. `"text/plain; charset=utf-8"` → `"text/plain"`
 *
 * @param contentType - Raw Content-Type header value, or null/undefined
 * @returns The bare media type, or null when the input is null/undefined
 */
export function parseMimeType(contentType: string | null | undefined): string | null {
    if (!(typeof contentType === "string")) return null;
    return contentType.split(";")[0]?.trim() ?? null;
}
