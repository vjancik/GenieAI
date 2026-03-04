/**
 * Base class for all application-specific errors.
 * Extends the native Error with a structured `code` field for programmatic error handling.
 */
export class AppError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = this.constructor.name;
    }
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
