import { EMPTY_MODEL_RESPONSE_MESSAGE, EMPTY_MODEL_RESPONSE_RETRY_ADVICE } from "../../domain/errors/AppError.ts";
import { FinishReason } from "../../domain/value-objects/FinishReason.ts";

/**
 * User-facing informational footers appended to a bot reply when the response is
 * degraded in some way. Each is a leading-newline italic line so it reads as an aside
 * beneath the answer, and each points the user at the Retry button.
 *
 * Kept separate from the response body by the caller so pagination offsets stored in the
 * DB always refer to positions within the response itself, never shifted by a footer.
 */

/**
 * Appended when the primary model was unavailable, a fallback model answered instead, and
 * the answering node treats fallback responses as retryable. Omitted for fallbacks configured
 * as non-retryable alternatives, even when the response is retryable for another reason.
 */
export const FALLBACK_FOOTER =
    "\n*This response was generated using a fallback model. If it's unsatisfactory you can Retry later to see if the primary model is available again.*";

/** Appended when the stream terminated with no finish reason at all, so content may be missing. */
export const INTERRUPTED_FOOTER = "\n*This response may be incomplete. If it's unsatisfactory you can Retry.*";

/** Content policy stops: safety, prohibited content, blocklisted terms, personal information. */
const FILTERED_FOOTER =
    "\n*This response was interrupted by a content filter. If it's unsatisfactory you can Retry to see if a fresh generation gets through.*";

/** The model began reproducing an existing source too closely and was halted. */
const RECITATION_FOOTER =
    "\n*This response was interrupted because it started closely reproducing an existing source. If it's unsatisfactory you can Retry to see if a fresh generation avoids it.*";

/** Output token budget exhausted before the model finished its answer. */
const LENGTH_FOOTER = "\n*This response was cut off because it got too long. If it's unsatisfactory you can Retry.*";

/** The model produced an unsupported language and was halted. */
const LANGUAGE_FOOTER =
    "\n*This response was interrupted because it used an unsupported language. If it's unsatisfactory you can Retry.*";

/** Image generation specifically failed or produced nothing. */
const IMAGE_FOOTER = "\n*The image for this response could not be generated. If it's unsatisfactory you can Retry.*";

/**
 * Catch-all for provider-side malfunctions with no useful user-facing explanation
 * (malformed responses, tool call faults, unknown reasons). These frequently clear
 * on their own, which is why the copy nudges toward a retry.
 */
const GLITCH_FOOTER =
    "\n*This response was interrupted by a problem on the model's end. If it's unsatisfactory you can Retry to see if it clears up.*";

/**
 * Maps every {@link FinishReason} to its user-facing footer, collapsing the provider's
 * fine-grained enum onto a handful of non-technical explanations. Typed as an exhaustive
 * Record so a newly added FinishReason fails typecheck until it is given a message.
 */
const FINISH_REASON_FOOTERS: Record<FinishReason, string> = {
    [FinishReason.STOP]: "",

    [FinishReason.MAX_TOKENS]: LENGTH_FOOTER,

    [FinishReason.SAFETY]: FILTERED_FOOTER,
    [FinishReason.PROHIBITED_CONTENT]: FILTERED_FOOTER,
    [FinishReason.BLOCKLIST]: FILTERED_FOOTER,
    [FinishReason.SPII]: FILTERED_FOOTER,
    [FinishReason.IMAGE_SAFETY]: FILTERED_FOOTER,
    [FinishReason.IMAGE_PROHIBITED_CONTENT]: FILTERED_FOOTER,

    [FinishReason.RECITATION]: RECITATION_FOOTER,
    [FinishReason.IMAGE_RECITATION]: RECITATION_FOOTER,

    [FinishReason.LANGUAGE]: LANGUAGE_FOOTER,

    [FinishReason.NO_IMAGE]: IMAGE_FOOTER,
    [FinishReason.IMAGE_OTHER]: IMAGE_FOOTER,

    [FinishReason.OTHER]: GLITCH_FOOTER,
    [FinishReason.FINISH_REASON_UNSPECIFIED]: GLITCH_FOOTER,
    [FinishReason.MALFORMED_FUNCTION_CALL]: GLITCH_FOOTER,
    [FinishReason.UNEXPECTED_TOOL_CALL]: GLITCH_FOOTER,
    [FinishReason.TOO_MANY_TOOL_CALLS]: GLITCH_FOOTER,
    [FinishReason.MISSING_THOUGHT_SIGNATURE]: GLITCH_FOOTER,
    [FinishReason.MALFORMED_RESPONSE]: GLITCH_FOOTER,
    [FinishReason.ESCALATION]: GLITCH_FOOTER,
};

/**
 * Returns the informational footer for a reported finish reason.
 *
 * @param reason - The reported reason, or null when none was reported
 * @returns The footer text, or an empty string for a clean stop or an absent reason
 *   (an absent reason is covered by {@link INTERRUPTED_FOOTER} instead)
 */
export function finishReasonFooter(reason: FinishReason | null): string {
    if (reason === null) return "";
    return FINISH_REASON_FOOTERS[reason];
}

/** How a response was generated, which determines the footer appended to it. */
interface ResponseFooterFlags {
    finishReason: FinishReason | null;
    wasInterrupted: boolean;
    usedRetryableFallback: boolean;
}

/**
 * Returns the combined footer for a response, or an empty string when nothing needs explaining.
 *
 * - The fallback notice is appended only when the fallback itself is a reason to retry. A
 *   fallback configured as non-retryable is an equal alternative rather than a downgrade, so
 *   there is nothing to explain, even if another signal made the response retryable.
 * - A reported non-STOP finish reason explains how generation ended specifically, so it wins
 *   over the generic interruption notice, which covers a response that ended with no reason at
 *   all. The two are mutually exclusive per model invocation, but each is sticky across graph
 *   nodes, so the precedence is enforced rather than assumed and the user never sees both.
 * - The fallback notice is orthogonal (which model answered, not how generation ended), so it
 *   may accompany either of the other two.
 */
export function responseFooter({ finishReason, wasInterrupted, usedRetryableFallback }: ResponseFooterFlags): string {
    const fallbackFooter = usedRetryableFallback ? FALLBACK_FOOTER : "";
    const reasonFooter = finishReasonFooter(finishReason);
    const generationFooter = reasonFooter === "" && wasInterrupted ? INTERRUPTED_FOOTER : reasonFooter;
    return fallbackFooter + generationFooter;
}

/** States what happened when the model returned no content; the footer explains why. */
const EMPTY_RESPONSE_NOTICE = EMPTY_MODEL_RESPONSE_MESSAGE;

/** Used when no footer follows, so the notice itself has to carry the retry advice. */
const EMPTY_RESPONSE_NOTICE_WITH_ADVICE = `${EMPTY_MODEL_RESPONSE_MESSAGE} ${EMPTY_MODEL_RESPONSE_RETRY_ADVICE}`;

/**
 * Returns the text displayed in place of an empty model response. It only says *what*
 * happened: when a footer will be appended, the footer already explains *why* and points at
 * Retry, so the notice omits its own retry advice to avoid repeating it.
 */
export function emptyResponseNotice(flags: ResponseFooterFlags): string {
    return responseFooter(flags) === "" ? EMPTY_RESPONSE_NOTICE_WITH_ADVICE : EMPTY_RESPONSE_NOTICE;
}
