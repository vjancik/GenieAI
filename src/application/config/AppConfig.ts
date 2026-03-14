import { ConfigError } from "../../domain/errors/AppError.ts";
import type { ThinkingLevel } from "../types/ThinkingLevel.ts";
import { THINKING_LEVELS } from "../types/ThinkingLevel.ts";

/** Controls how file attachments are included in LLM requests. */
export type AttachmentMode = "inline" | "upload";

/**
 * Typed configuration for the application.
 * All values are sourced from environment variables and validated at startup.
 */
export interface AppConfig {
    discordToken: string;
    /**
     * Free-tier Google API keys used for triage and general model rotation.
     * At least one is required. Keys rotate round-robin on HTTP 429 responses.
     * Sourced from GOOGLE_FREE_API_KEYS (comma-separated).
     */
    googleFreeApiKeys: string[];
    /**
     * Paid Google API key used exclusively for the search model (Google Search
     * grounding is a paid-only feature). Sourced from GOOGLE_PAID_API_KEY.
     */
    googlePaidApiKey: string;
    databaseUrl: string;
    /** Gemini reasoning effort level for the triage model. */
    triageThinkingLevel: ThinkingLevel;
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
     * Default: "upload"
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
    /**
     * Optional HTTP/HTTPS proxy URL passed to yt-dlp and used for caption fetches.
     * Must use the http:// or https:// scheme. Sourced from YT_DLP_HTTP_PROXY.
     */
    ytDlpHttpProxy: string | undefined;
    /**
     * Number of times to retry yt-dlp metadata and caption fetches when the proxy
     * rotates on bot-detection errors or 429 responses. Only meaningful when
     * YT_DLP_HTTP_PROXY is set. Default: 5.
     */
    proxyRetries: number;
}

/**
 * Parses and validates the TRIAGE_THINKING_LEVEL environment variable.
 * Accepts case-insensitive input and normalizes to uppercase.
 * Throws {@link ConfigError} for unknown values.
 */
function parseThinkingLevel(raw: string | undefined): ThinkingLevel {
    const normalized = (raw ?? "LOW").toUpperCase();
    if ((THINKING_LEVELS as readonly string[]).includes(normalized)) {
        return normalized as ThinkingLevel;
    }
    throw new ConfigError(
        `Invalid TRIAGE_THINKING_LEVEL value: "${raw}". Expected one of: ${THINKING_LEVELS.join(", ")}.`,
    );
}

/**
 * Parses and validates the UPLOAD_ATTACHMENT_MODE environment variable.
 * Throws {@link ConfigError} for unknown values.
 */
function parseAttachmentMode(raw: string | undefined): AttachmentMode {
    const value = raw ?? "upload";
    if (value === "inline") return "inline";
    if (value === "upload") return "upload";
    throw new ConfigError(`Invalid UPLOAD_ATTACHMENT_MODE value: "${value}". Expected "inline" or "upload".`);
}

/**
 * Parses and validates the GOOGLE_FREE_API_KEYS environment variable.
 *
 * Splits on commas, trims whitespace, and filters empty strings.
 * Throws {@link ConfigError} if the result is empty.
 */
function parseFreeApiKeys(raw: string | undefined): string[] {
    const keys = (raw ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
    if (keys.length === 0) {
        throw new ConfigError("GOOGLE_FREE_API_KEYS is required and must contain at least one API key");
    }
    return keys;
}

/**
 * Parses and validates the GOOGLE_PAID_API_KEY environment variable.
 *
 * Throws {@link ConfigError} if missing or if multiple keys are provided
 * (comma-separated paid keys are not supported — use GOOGLE_FREE_API_KEYS for rotation).
 */
function parsePaidApiKey(raw: string | undefined): string {
    if (!raw?.trim()) {
        throw new ConfigError("GOOGLE_PAID_API_KEY is required (paid key for Google Search grounding)");
    }
    if (raw.includes(",")) {
        throw new ConfigError("GOOGLE_PAID_API_KEY must be a single key. For multiple keys use GOOGLE_FREE_API_KEYS.");
    }
    return raw.trim();
}

/**
 * Parses and validates all required environment variables.
 * Throws {@link ConfigError} immediately if any required variable is missing,
 * preventing the application from starting in a misconfigured state.
 */
export function loadConfig(): AppConfig {
    const requiredVars = ["DISCORD_TOKEN", "DATABASE_URL"] as const;

    for (const key of requiredVars) {
        if (!process.env[key]) {
            throw new ConfigError(`Missing required environment variable: ${key}`);
        }
    }

    const discordToken = process.env.DISCORD_TOKEN ?? "";
    const databaseUrl = process.env.DATABASE_URL ?? "";

    return {
        discordToken,
        googleFreeApiKeys: parseFreeApiKeys(process.env.GOOGLE_FREE_API_KEYS),
        googlePaidApiKey: parsePaidApiKey(process.env.GOOGLE_PAID_API_KEY),
        databaseUrl,
        triageThinkingLevel: parseThinkingLevel(process.env.TRIAGE_THINKING_LEVEL),
        includeLLMThoughts: process.env.INCLUDE_LLM_THOUGHTS === "true",
        logLevel: process.env.LOG_LEVEL ?? "info",
        fileLog: process.env.FILE_LOG === "true",
        attachmentMode: parseAttachmentMode(process.env.UPLOAD_ATTACHMENT_MODE),
        maxInlineAttachmentSizeMb: Number(process.env.MAX_INLINE_ATTACHMENT_SZ_MB ?? "100"),
        geminiFileStaleThresholdMinutes: Number(process.env.GEMINI_FILE_STALE_THRESHOLD_MINUTES ?? "15"),
        ytDlpHttpProxy: process.env.YT_DLP_HTTP_PROXY?.trim() || undefined,
        proxyRetries: Number(process.env.PROXY_RETRIES ?? "5"),
    };
}
