export class ApplicationError extends Error {
    constructor(
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = this.constructor.name;
    }
}

export class DatabaseError extends ApplicationError {
    constructor(message: string, cause?: unknown) {
        super(message || 'A database error occurred', { cause });
    }
}

export class AIProviderError extends ApplicationError {
    constructor(message: string, cause?: unknown) {
        super(message || 'The AI service encountered an error', { cause });
    }
}

export class DiscordError extends ApplicationError {
    constructor(message: string, cause?: unknown) {
        super(message || 'A Discord-related error occurred', { cause });
    }
}
