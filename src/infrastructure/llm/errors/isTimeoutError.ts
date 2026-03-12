/**
 * Returns true if the error represents a request timeout or abort.
 *
 * Covers the following cases:
 * - `DOMException` with name "TimeoutError" — thrown by `AbortSignal.timeout()` when the
 *   signal fires, which is how LangChain surfaces `RunnableConfig.timeout` expiry.
 * - `DOMException` / `Error` with name "AbortError" — thrown when an AbortSignal is
 *   manually aborted or when fetch is cancelled.
 * - Generic errors whose message contains "timeout" — a catch-all for LangChain or
 *   underlying HTTP client error strings.
 */
export function isTimeoutError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) {
        return false;
    }

    const name = (err as { name?: unknown }).name;

    // AbortSignal.timeout() throws a DOMException named "TimeoutError"
    if (name === "TimeoutError") {
        return true;
    }

    // Manual AbortController abort, or fetch cancellation
    if (name === "AbortError") {
        return true;
    }

    // Fallback: check the error message for "timeout" keyword
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && /timeout/i.test(msg)) {
        return true;
    }

    return false;
}
