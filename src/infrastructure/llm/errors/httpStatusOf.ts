/**
 * Reads the HTTP status code an error carries as a structured property, or null when it has
 * none. Never parses the error message. Covers every error shape a Gemini call can surface:
 * - `@langchain/google` `RequestError` (model calls) carries it as `statusCode`
 * - `@google/genai` `ApiError` (Files API calls) and our own `GeminiUploadHttpError`
 *   (file uploads) carry it as `status`
 */
export function httpStatusOf(err: unknown): number | null {
    if (typeof err !== "object" || err === null) return null;
    const status = "statusCode" in err ? err.statusCode : "status" in err ? err.status : undefined;
    return typeof status === "number" ? status : null;
}
