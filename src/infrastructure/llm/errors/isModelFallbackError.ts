import { is503Error } from "./is503Error.ts";
import { isTimeoutError } from "./isTimeoutError.ts";

/**
 * Returns true if the error should trigger a model fallback attempt.
 *
 * Fallback is activated on 503 (Service Unavailable) and timeout/abort errors.
 * 429 (rate limit) errors are intentionally excluded — those bubble up to the
 * free-key rotation middleware instead.
 */
export function isModelFallbackError(err: unknown): boolean {
    return is503Error(err) || isTimeoutError(err);
}
