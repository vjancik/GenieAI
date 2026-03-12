/**
 * Returns true if the error appears to be an HTTP 503 (Service Unavailable) response
 * from the Gemini API as surfaced through the LangChain stack.
 *
 * Checks HTTP status code and common message patterns to catch all known representations.
 * Mirrors the structure of {@link is429Error}.
 */
export function is503Error(err: unknown): boolean {
    const SERVICE_UNAVAILABLE_PATTERN = /503|Service\s*Unavailable|server\s*error/i;

    if (typeof err === "string") {
        return SERVICE_UNAVAILABLE_PATTERN.test(err);
    }

    if (typeof err !== "object" || err === null) {
        return false;
    }

    // Check HTTP status code if present (e.g. HTTPError or fetch Response shapes)
    const status =
        (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (status === 503) {
        return true;
    }

    // Check common error.message property
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && SERVICE_UNAVAILABLE_PATTERN.test(msg)) {
        return true;
    }

    return false;
}
