import { httpStatusOf } from "./httpStatusOf.ts";

/**
 * HTTP statuses with which Tavily rejects the API key rather than the request: invalid or missing
 * key (401), forbidden (403), rate-limited (429), key or plan usage limit exceeded, i.e. out of
 * credits (432), and pay-as-you-go limit exceeded (433).
 *
 * Kept apart from the Gemini set because 432 and 433 are Tavily-specific, non-standard statuses.
 */
const TAVILY_KEY_ROTATION_STATUS_CODES: readonly number[] = [401, 403, 429, 432, 433];

/**
 * Returns true if a Tavily request error warrants rotating to the next API key, because another
 * key may well succeed.
 *
 * NOTE: Tavily's rate limits apply per account and are shared by all of its keys, as are plan
 * limits, so rotating on 429 or 432 only helps when the next key belongs to another account.
 *
 * Matched on the structured HTTP status code only (see {@link httpStatusOf}), never on the error
 * message, as Tavily's documentation advises.
 */
export function isTavilyKeyRotationError(err: unknown): boolean {
    const status = httpStatusOf(err);
    return status !== null && TAVILY_KEY_ROTATION_STATUS_CODES.includes(status);
}
