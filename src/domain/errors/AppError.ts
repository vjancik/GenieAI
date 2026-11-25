import { BlockReason } from "../value-objects/BlockReason.ts";

/**
 * Base class for all application-specific errors.
 * Extends the native Error with a structured `code` field for programmatic error handling.
 *
 * @param displayMessage - Optional user-facing message to surface in the UI instead of the
 *   generic fallback. Only AppError subclasses are trusted for display (see extractDisplayMessage).
 */
export class AppError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public override readonly cause?: unknown,
        public readonly displayMessage?: string,
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

/**
 * Walks the `cause` chain of an error looking for the first {@link AppError} that carries a
 * `displayMessage`. Only AppError instances are trusted — this guards against accidentally
 * surfacing display strings (or other user-facing hints, see {@link getDeclaredRetryable}) from
 * third-party errors that happen to have matching properties.
 *
 * Returns `null` if no such error is found.
 */
export function findDisplayableError(err: unknown): AppError | null {
    let current: unknown = err;
    while (current instanceof Error) {
        if (current instanceof AppError && current.displayMessage !== undefined) {
            return current;
        }
        current = current.cause;
    }
    return null;
}

/** Returns the display message of the error found by {@link findDisplayableError}, or `null`. */
export function extractDisplayMessage(err: unknown): string | null {
    return findDisplayableError(err)?.displayMessage ?? null;
}

/**
 * Returns the retryability an {@link AppError} subclass explicitly declares through a boolean
 * `retryable` property, or `null` when it declares none and the caller's default applies.
 * Accepts only AppErrors so the property is never read off an error we didn't create.
 */
export function getDeclaredRetryable(err: AppError): boolean | null {
    return "retryable" in err && typeof err.retryable === "boolean" ? err.retryable : null;
}

/** Thrown when a required environment variable is missing or misconfigured. */
export class ConfigError extends AppError {
    constructor(message: string) {
        super("CONFIG_ERROR", message);
    }
}

/** Thrown when a database operation fails. */
export class DatabaseError extends AppError {
    constructor(message: string, cause?: unknown) {
        super("DB_ERROR", message, cause);
    }
}

/** Thrown when an agent tool execution fails. */
export class ToolError extends AppError {
    constructor(message: string, cause?: unknown) {
        super("TOOL_ERROR", message, cause);
    }
}

/**
 * Why a web page could not be retrieved. Distinguishes causes the model should
 * relay differently — a paywall is not a transient failure, and a bot block is
 * not a bad URL.
 */
export type WebFetchFailure =
    | "http-error"
    | "timeout"
    | "unreachable"
    | "unsupported-content"
    | "too-large"
    | "insecure-url"
    | "private-address"
    | "blocked"
    | "paywalled"
    | "client-rendered"
    | "no-article"
    | "empty";

/**
 * Failures that fetching the same URL again cannot fix: they stem from a fixed policy or
 * from what the URL serves, not from a transient condition. A URL that failed this way is
 * not fetched again in a later turn.
 */
export const PERMANENT_WEB_FETCH_FAILURES: ReadonlySet<string> = new Set<WebFetchFailure>([
    "unsupported-content",
    "too-large",
    "insecure-url",
    "private-address",
]);

/**
 * Thrown when a web page fetch fails, carrying a machine-readable reason so the
 * tool can explain *why* rather than reporting a generic failure.
 */
export class WebFetchError extends ToolError {
    constructor(
        public readonly reason: WebFetchFailure,
        message: string,
        cause?: unknown,
    ) {
        super(message, cause);
    }
}

/**
 * Thrown when a video's metadata was retrieved but it has no usable caption tracks.
 * Unlike transient fetch failures, this is a definitive answer the model should relay
 * to the user, so it carries the video's title and author for context.
 */
export class NoCaptionsError extends ToolError {
    constructor(
        message: string,
        public readonly title: string | null,
        public readonly author: string | null,
    ) {
        super(message);
    }
}

/** Thrown when a Discord event cannot be processed. */
export class DiscordError extends AppError {
    constructor(message: string, cause?: unknown) {
        super("DISCORD_ERROR", message, cause);
    }
}

/** Discord API error code for missing channel permissions. */
const DISCORD_MISSING_PERMISSIONS_CODE = 50013;

/** Returns true if `err` is a Discord API error with the Missing Permissions code. */
export function isMissingPermissionsError(err: unknown): boolean {
    return (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === DISCORD_MISSING_PERMISSIONS_CODE
    );
}

/** Thrown when every free-tier Gemini API key has been rejected (HTTP 401, 402, 403) or rate-limited (HTTP 429). */
export class AllFreeKeysExhaustedError extends AppError {
    constructor(cause?: unknown) {
        super(
            "ALL_FREE_KEYS_EXHAUSTED",
            "All free Gemini API keys are rejected or rate-limited",
            cause,
            "All free API keys are currently exhausted, please try again later.",
        );
    }
}

/**
 * Thrown when every Tavily API key has been rejected, rate-limited or has run out of credits.
 * The display message deliberately names no provider.
 */
export class AllSearchKeysExhaustedError extends AppError {
    constructor(cause?: unknown) {
        super(
            "ALL_SEARCH_KEYS_EXHAUSTED",
            "All Tavily API keys are rejected, rate-limited or out of credits",
            cause,
            "All search provider API keys are currently exhausted, please try again later.",
        );
    }
}

/**
 * Thrown when a Tavily search request fails: a non-OK HTTP response, a malformed response body,
 * or a request that never got a response (network failure or timeout). Carries the response's
 * `status` (null when there was no response or it was OK but malformed) so callers can classify
 * the failure, e.g. as a rejected or exhausted API key, without parsing the message.
 * The display message deliberately names no provider.
 */
export class TavilySearchError extends AppError {
    /**
     * @param message - Description of what went wrong
     * @param status  - HTTP status code of the failed response, or null when there is none to report
     * @param body    - Raw response body, kept for diagnostics; null when there was no response
     * @param cause   - The underlying error, for failures without a response
     */
    constructor(
        message: string,
        public readonly status: number | null,
        public readonly body: string | null,
        cause?: unknown,
    ) {
        super("TAVILY_SEARCH_FAILED", message, cause, "The search provider failed to respond, please try again later.");
    }
}

/**
 * Thrown when a Gemini Files API upload request is answered with a non-OK HTTP response.
 * Carries the response's `status` as a structured property so that callers can classify the
 * failure (e.g. a rejected or rate-limited API key) without parsing the message.
 */
export class GeminiUploadHttpError extends AppError {
    /**
     * @param message - Description of the upload step that failed
     * @param status  - HTTP status code of the failed response
     * @param body    - Raw response body, kept for diagnostics
     */
    constructor(
        message: string,
        public readonly status: number,
        public readonly body: string,
    ) {
        super("GEMINI_UPLOAD_FAILED", message);
    }
}

/**
 * Thrown when a Gemini `countTokens` request is answered with a non-OK HTTP response or an
 * unexpected body. Carries the response's `status` (null for a malformed body) so callers can
 * classify the failure without parsing the message.
 */
export class TokenCountError extends AppError {
    /**
     * @param message - Description of what went wrong
     * @param status  - HTTP status code of the failed response, or null when the response was OK but malformed
     * @param body    - Raw response body, kept for diagnostics
     */
    constructor(
        message: string,
        public readonly status: number | null,
        public readonly body: string,
    ) {
        super("TOKEN_COUNT_FAILED", message);
    }
}

/**
 * Thrown before a model call is sent when its input exceeds the configured `agent.maxInputTokens`
 * budget. Not retryable: resending the same input exceeds the budget again, and so does replying
 * to the failed message, which resends the whole reply chain.
 */
export class InputTokenBudgetExceededError extends AppError {
    /** Declared for {@link getDeclaredRetryable}, overriding the default that failures are retryable. */
    readonly retryable = false;

    constructor(
        public readonly inputTokens: number,
        public readonly maxInputTokens: number,
    ) {
        super(
            "INPUT_TOKEN_BUDGET_EXCEEDED",
            `Model input of ${inputTokens} tokens exceeds the input token budget of ${maxInputTokens}`,
            undefined,
            "The request has surpassed the configured token limit and won't be processed. Replying to this message " +
                "would resend it, so try again in a new message with fewer or smaller attachments, or as a reply to " +
                "an earlier message in a shorter conversation.",
        );
    }
}

/**
 * Formats a positive duration as a rounded-up, human-readable English phrase, e.g. "45 seconds",
 * "12 minutes" or "3 hours and 5 minutes". Rounds up so the user is never told to come back too early.
 */
function formatWaitDuration(ms: number): string {
    const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    if (seconds < 60) return plural(seconds, "second");
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return plural(minutes, "minute");
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} and ${plural(restMinutes, "minute")}`;
}

/**
 * Thrown before a model call when the requesting user has used up their token allowance in one
 * of the configured `discord.tokenRateLimits` windows. Not retryable: it's an abuse-prevention
 * limit, so the user re-sends manually once the window frees up. Replying to the notice is fine.
 */
export class TokenRateLimitExceededError extends AppError {
    /** Declared for {@link getDeclaredRetryable}, overriding the default that failures are retryable. */
    readonly retryable = false;

    constructor(public readonly retryAfterMs: number) {
        super(
            "TOKEN_RATE_LIMIT_EXCEEDED",
            `Token rate limit exceeded, retry after ${retryAfterMs} ms`,
            undefined,
            `You've used up your token allowance for now. You can send new requests again in about ${formatWaitDuration(retryAfterMs)}.`,
        );
    }
}

/** Thrown when an LLM produces an invalid or unexpected response (e.g. tool calls from a user-facing model). */
export class LlmError extends AppError {
    constructor(message: string, cause?: unknown) {
        super("LLM_ERROR", message, cause);
    }
}

/** Thrown when a model call is rejected because the AI provider's servers are overloaded (HTTP 503). */
export class ModelOverloadedError extends AppError {
    constructor(cause?: unknown) {
        super(
            "MODEL_OVERLOADED",
            "The AI provider is overloaded and rejected the model call",
            cause,
            "The AI provider servers are temporarily overloaded, you can try again later.",
        );
    }
}

/**
 * States that the model returned no usable content. Shared by {@link ModelNoCandidatesError}
 * and the empty-response notice in the application formatters so the two can't drift apart.
 */
export const EMPTY_MODEL_RESPONSE_MESSAGE = "The AI model returned an empty response.";

/** Retry advice accompanying {@link EMPTY_MODEL_RESPONSE_MESSAGE} when nothing else offers it. */
export const EMPTY_MODEL_RESPONSE_RETRY_ADVICE =
    "A retry usually fixes this unless the provider servers are temporarily overloaded.";

/**
 * Thrown when the model provider responded without a single answer candidate and without saying
 * the prompt was blocked. Treated as a transient provider-side failure, like a 503.
 */
export class ModelNoCandidatesError extends AppError {
    constructor(cause?: unknown) {
        super(
            "MODEL_NO_CANDIDATES",
            "The AI provider returned no answer candidates",
            cause,
            `${EMPTY_MODEL_RESPONSE_MESSAGE} ${EMPTY_MODEL_RESPONSE_RETRY_ADVICE}`,
        );
    }
}

/**
 * Appended to every blocked-prompt display message. The blocked message stays in the reply chain,
 * so any reply to it resends the blocked content and is blocked as well.
 */
const BLOCKED_PROMPT_ADVICE =
    "Replying to this message will be blocked too, so try again with different content in a new message or as a reply to an earlier one.";

/** User-facing explanation per {@link BlockReason}; exhaustive so a new reason fails typecheck. */
const BLOCK_REASON_MESSAGES: Record<BlockReason, string> = {
    [BlockReason.SAFETY]: "The AI provider's safety filter blocked this request.",
    [BlockReason.BLOCKLIST]: "The AI provider blocked this request because it contains blocklisted terms.",
    [BlockReason.PROHIBITED_CONTENT]: "The AI provider blocked this request because it may contain prohibited content.",
    [BlockReason.IMAGE_SAFETY]: "The AI provider's safety filter blocked an image in this request.",
    [BlockReason.OTHER]: "The AI provider blocked this request.",
    [BlockReason.BLOCK_REASON_UNSPECIFIED]: "The AI provider blocked this request.",
};

/**
 * Thrown when the model provider refused to process the prompt. Not retryable: the block is a
 * verdict on the input, so resending the same input is blocked again.
 */
export class ModelPromptBlockedError extends AppError {
    /** Declared for {@link getDeclaredRetryable}, overriding the default that failures are retryable. */
    readonly retryable = false;

    constructor(
        public readonly blockReason: BlockReason,
        cause?: unknown,
    ) {
        super(
            "MODEL_PROMPT_BLOCKED",
            `The AI provider blocked the prompt: ${blockReason}`,
            cause,
            `${BLOCK_REASON_MESSAGES[blockReason]} ${BLOCKED_PROMPT_ADVICE}`,
        );
    }
}

/** Thrown when a model call times out or is aborted before the model responds. */
export class ModelTimeoutError extends AppError {
    constructor(cause?: unknown) {
        super(
            "MODEL_TIMEOUT",
            "The model did not respond within the allotted time",
            cause,
            "The AI model failed to respond within allotted time, you can try again later.",
        );
    }
}

/** Thrown when every paid Gemini API key has been rejected (HTTP 401, 402, 403) or rate-limited (HTTP 429). */
export class AllPaidKeysExhaustedError extends AppError {
    constructor(cause?: unknown) {
        super(
            "ALL_PAID_KEYS_EXHAUSTED",
            "All paid Gemini API keys are rejected or rate-limited",
            cause,
            "All paid API keys are currently rejected or rate limited, please try again later.",
        );
    }
}
