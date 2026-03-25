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
 * surfacing display strings from third-party errors that happen to have a `displayMessage`
 * property.
 *
 * Returns `null` if no such error is found.
 */
export function extractDisplayMessage(err: unknown): string | null {
    let current: unknown = err;
    while (current instanceof Error) {
        if (current instanceof AppError && current.displayMessage !== undefined) {
            return current.displayMessage;
        }
        current = current.cause;
    }
    return null;
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
