import { is503Error } from "./is503Error.ts";
import { isNoCandidatesError } from "./isNoCandidatesError.ts";
import { isPromptBlockedError } from "./isPromptBlockedError.ts";
import { isTimeoutError } from "./isTimeoutError.ts";

/**
 * Returns true if the error should trigger a model fallback attempt.
 *
 * Fallback is activated on:
 * - 503 (Service Unavailable) and timeout/abort errors — transient provider-side failures.
 * - A response without answer candidates — treated as a transient failure like a 503.
 * - A blocked prompt — almost always a verdict on the input that the fallback model will share,
 *   but trying it gets around the unlikely case of a per-model block.
 *
 * Rate limit (429) and key rejection (401, 402, 403) errors are intentionally excluded — those
 * are resolved by rotating to the next API key instead.
 */
export function isModelFallbackError(err: unknown): boolean {
    return is503Error(err) || isTimeoutError(err) || isNoCandidatesError(err) || isPromptBlockedError(err);
}
