import { ConfigError } from "../../domain/errors/AppError.ts";

/** Controls how file attachments are included in LLM requests. */
export type AttachmentMode = "inline" | "upload";

/**
 * Typed configuration for the application.
 * All values are sourced from environment variables and validated at startup.
 */
export interface AppConfig {
    discordToken: string;
    // discordClientId: string;
    googleApiKey: string;
    databaseUrl: string;
    /** Number of reasoning tokens allocated to the triage model. Default: 512. Set to 0 to disable. */
    triageThinkingBudget: number;
    triageThinkingLevel: string;
    includeLLMThoughts: boolean;
    /** Pino log level. Default: "info" */
    logLevel: string;
    /**
     * How file attachments are passed to the LLM.
     * - "inline": base64-encoded directly in the message (cross-provider, high memory overhead)
     * - "upload": uploaded via provider file API (Gemini-only, not yet implemented)
     * Default: "inline"
     */
    attachmentMode: AttachmentMode;
    /**
     * Maximum total size in MB for inline attachments per message and for the cumulative
     * inline attachment data across the entire conversation history.
     * Default: 100
     */
    maxInlineAttachmentSizeMb: number;
}

/**
 * Parses and validates all required environment variables.
 * Throws {@link ConfigError} immediately if any required variable is missing,
 * preventing the application from starting in a misconfigured state.
 */
function loadConfig(): AppConfig {
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
        triageThinkingBudget: Number(
            process.env.TRIAGE_THINKING_BUDGET ?? "512",
        ),
        triageThinkingLevel: process.env.TRIAGE_THINKING_LEVEL ?? "minimal",
        includeLLMThoughts: process.env.INCLUDE_LLM_THOUGHTS === "true",
        logLevel: process.env.LOG_LEVEL ?? "info",
        attachmentMode: parseAttachmentMode(process.env.UPLOAD_ATTACHMENT_MODE),
        maxInlineAttachmentSizeMb: Number(
            process.env.MAX_INLINE_ATTACHMENT_SZ_MB ?? "100",
        ),
    };
}

/**
 * Parses and validates the UPLOAD_ATTACHMENT_MODE environment variable.
 * Throws {@link ConfigError} if the value is "upload" (not yet implemented)
 * or an unknown string.
 */
function parseAttachmentMode(raw: string | undefined): AttachmentMode {
    const value = raw ?? "inline";
    if (value === "inline") return "inline";
    if (value === "upload") {
        throw new ConfigError(
            "Upload attachment mode is not yet implemented. Set UPLOAD_ATTACHMENT_MODE=inline or leave it unset.",
        );
    }
    throw new ConfigError(
        `Invalid UPLOAD_ATTACHMENT_MODE value: "${value}". Expected "inline" or "upload".`,
    );
}

export const config: AppConfig = loadConfig();
