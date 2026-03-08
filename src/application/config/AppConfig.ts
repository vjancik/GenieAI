import { ConfigError } from "../../domain/errors/AppError.ts";

/** Controls how file attachments are included in LLM requests. */
export type AttachmentMode = "inline" | "upload";

/**
 * Typed configuration for the application.
 * All values are sourced from environment variables and validated at startup.
 */
export interface AppConfig {
    discordToken: string;
    googleApiKey: string;
    databaseUrl: string;
    /** Gemini 3 Reasoning effort level */
    triageThinkingLevel: string;
    /** Whether to include LLM thoughts in the LLM responses for debugging purposes */
    includeLLMThoughts: boolean;
    /** Pino log level. Default: "info" */
    logLevel: string;
    /**
     * Whether to additionally write structured JSON logs to a file at
     * `./logs/<process-start-timestamp>-pino.log`. Runs in parallel with console output.
     * Default: false
     */
    fileLog: boolean;
    /**
     * How file attachments are passed to the LLM.
     * - "inline": base64-encoded directly in the message (cross-provider, high memory overhead)
     * - "upload": uploaded via Gemini Files API (Gemini only, streaming to disk)
     * Default: "inline"
     */
    attachmentMode: AttachmentMode;
    /**
     * Maximum total size in MB for inline attachments per message and for the cumulative
     * inline attachment data across the entire conversation history.
     * Default: 100
     */
    maxInlineAttachmentSizeMb: number;
    /**
     * How many minutes before expiry a Gemini file is considered stale and will be
     * re-uploaded before the next LLM invocation. Gemini files expire after 48 hours.
     * A file uploaded more than (48h - staleThreshold) ago is refreshed.
     * Only relevant when attachmentMode is "upload".
     * Default: 60 (refresh when less than 1 hour of TTL remains)
     */
    geminiFileStaleThresholdMinutes: number;
}

/**
 * Parses and validates the UPLOAD_ATTACHMENT_MODE environment variable.
 * Throws {@link ConfigError} for unknown values.
 */
function parseAttachmentMode(raw: string | undefined): AttachmentMode {
    const value = raw ?? "upload";
    if (value === "inline") return "inline";
    if (value === "upload") return "upload";
    throw new ConfigError(
        `Invalid UPLOAD_ATTACHMENT_MODE value: "${value}". Expected "inline" or "upload".`,
    );
}

/**
 * Parses and validates all required environment variables.
 * Throws {@link ConfigError} immediately if any required variable is missing,
 * preventing the application from starting in a misconfigured state.
 */
export function loadConfig(): AppConfig {
    const requiredVars = [
        "DISCORD_TOKEN",
        // "DISCORD_CLIENT_ID",
        "GOOGLE_API_KEY",
        "DATABASE_URL",
    ] as const;

    for (const key of requiredVars) {
        if (!process.env[key]) {
            throw new ConfigError(
                `Missing required environment variable: ${key}`,
            );
        }
    }

    // All four vars are guaranteed non-empty by the guard loop above
    const discordToken = process.env.DISCORD_TOKEN ?? "";
    // const discordClientId = process.env.DISCORD_CLIENT_ID ?? "";
    const googleApiKey = process.env.GOOGLE_API_KEY ?? "";
    const databaseUrl = process.env.DATABASE_URL ?? "";

    return {
        discordToken,
        // discordClientId,
        googleApiKey,
        databaseUrl,
        triageThinkingLevel: process.env.TRIAGE_THINKING_LEVEL ?? "minimal",
        includeLLMThoughts: process.env.INCLUDE_LLM_THOUGHTS === "true",
        logLevel: process.env.LOG_LEVEL ?? "info",
        fileLog: process.env.FILE_LOG === "true",
        attachmentMode: parseAttachmentMode(process.env.UPLOAD_ATTACHMENT_MODE),
        maxInlineAttachmentSizeMb: Number(
            process.env.MAX_INLINE_ATTACHMENT_SZ_MB ?? "100",
        ),
        geminiFileStaleThresholdMinutes: Number(
            process.env.GEMINI_FILE_STALE_THRESHOLD_MINUTES ?? "15",
        ),
    };
}
