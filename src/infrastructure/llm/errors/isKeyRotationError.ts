import { httpStatusOf } from "./httpStatusOf.ts";

/**
 * HTTP statuses meaning the API key, rather than the request, is what failed: unauthenticated
 * (401), payment required (402), forbidden (403) and rate-limited / quota exhausted (429).
 */
const KEY_ROTATION_STATUS_CODES: readonly number[] = [401, 402, 403, 429];

/**
 * Returns true if the error warrants rotating to the next API key, because the current one was
 * rejected outright or rate-limited and another key may well succeed.
 *
 * Matched on the structured HTTP status code only (see {@link httpStatusOf}), never on the error
 * message: messages embed arbitrary upstream text (token counts, safety rating JSON, response
 * bodies) in which a status-like number can appear by accident.
 */
export function isKeyRotationError(err: unknown): boolean {
    const status = httpStatusOf(err);
    return status !== null && KEY_ROTATION_STATUS_CODES.includes(status);
}
