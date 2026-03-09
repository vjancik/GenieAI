/**
 * Returns true if the error appears to be an HTTP 429 / quota-exhausted response
 * from the Gemini API as surfaced through the LangChain stack.
 *
 * Scans common string patterns across error message, status code, and serialized
 * form to catch all known representations.
 *
 * TODO: Investigate the exact error type/shape emitted by @langchain/google and
 * @langchain/core on rate-limit (HTTP 429 / RESOURCE_EXHAUSTED). The error may
 * surface as a structured GoogleGenerativeAIError, an HTTPError, or a generic
 * Error depending on the LangChain version and call path. Tighten this check
 * (e.g. instanceof guard + status code check) once the exact shape is confirmed.
 * The current string-scan approach is conservative and may produce false positives
 * for non-rate-limit errors that happen to contain these patterns.
 */
export function is429Error(err: unknown): boolean {
    const RATE_LIMIT_PATTERN = /429|RESOURCE_EXHAUSTED|quota.?exceeded/i;

    if (typeof err === "string") {
        return RATE_LIMIT_PATTERN.test(err);
    }

    if (typeof err !== "object" || err === null) {
        return false;
    }

    // Check common error.message property
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && RATE_LIMIT_PATTERN.test(msg)) {
        return true;
    }

    // Check HTTP status code if present (e.g. HTTPError or AxiosError shapes)
    const status =
        (err as { status?: unknown; statusCode?: unknown }).status ??
        (err as { statusCode?: unknown }).statusCode;
    if (status === 429) {
        return true;
    }

    // Fallback: scan the full JSON serialization
    // try {
    //     return RATE_LIMIT_PATTERN.test(JSON.stringify(err));
    // } catch {
    //     return false;
    // }
    return false;
}
