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
    | "blocked"
    | "paywalled"
    | "client-rendered"
    | "no-article"
    | "empty";

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

/** Thrown when all free-tier Gemini API keys have responded with HTTP 429. */
export class AllFreeKeysExhaustedError extends AppError {
    constructor(cause?: unknown) {
        super(
            "ALL_FREE_KEYS_EXHAUSTED",
            "All free Gemini API keys are rate-limited",
            cause,
            "All free API keys are currently exhausted, please try again later.",
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

/** Thrown when the paid Gemini API key responds with HTTP 429. */
export class PaidKeyExhaustedError extends AppError {
    constructor(cause?: unknown) {
        super(
            "PAID_KEY_EXHAUSTED",
            "The paid Gemini API key is rate-limited",
            cause,
            "The paid API key has reached spending quota and is being rate limited.",
        );
    }
}
