import {
    ModelNoCandidatesError,
    ModelOverloadedError,
    ModelPromptBlockedError,
    ModelTimeoutError,
} from "../../../domain/errors/AppError.ts";
import { parseBlockReason } from "../../../domain/value-objects/BlockReason.ts";
import { isNoCandidatesError } from "./isNoCandidatesError.ts";
import { isPromptBlockedError } from "./isPromptBlockedError.ts";
import { isTimeoutError } from "./isTimeoutError.ts";

/**
 * Returns true if the error is the Gemini API's high-demand rejection: a `@langchain/google`
 * `RequestError` carrying HTTP status 503 (`UNAVAILABLE`). Matched structurally on `statusCode`
 * because the package does not export `RequestError`.
 *
 * Deliberately stricter than `is503Error`, which also matches loose message patterns
 * (e.g. "server error") to decide whether a fallback model is worth trying.
 */
function isOverloadedResponse(err: unknown): boolean {
    return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 503;
}

/**
 * Maps the error of the last model call the resilient invoker evaluated before giving up to a
 * model-scoped {@link AppError} carrying a user-facing display message, with the raw error as
 * its cause. Errors without a model-specific meaning are returned unchanged.
 *
 * Blocked prompts and missing candidates are checked first: they are matched by their exact
 * shape, while the later checks also scan messages, which for a blocked prompt embed arbitrary
 * safety rating JSON.
 */
export function toModelFailureError(err: unknown): unknown {
    if (isPromptBlockedError(err)) return new ModelPromptBlockedError(parseBlockReason(err.blockReason), err);
    if (isNoCandidatesError(err)) return new ModelNoCandidatesError(err);
    if (isOverloadedResponse(err)) return new ModelOverloadedError(err);
    if (isTimeoutError(err)) return new ModelTimeoutError(err);
    return err;
}
