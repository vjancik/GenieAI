import { file } from "bun";
import { z } from "zod/v4";
import { ConfigError } from "../../domain/errors/AppError.ts";
import type { Logger } from "../types/Logger.ts";
import { THINKING_LEVELS } from "../types/ThinkingLevel.ts";

/** Controls how file attachments are included in LLM requests. */
export const AttachmentMode = {
    inline: "inline",
    upload: "upload",
} as const;

export type AttachmentMode = (typeof AttachmentMode)[keyof typeof AttachmentMode];

const ATTACHMENT_MODES = Object.values(AttachmentMode) as readonly AttachmentMode[];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = "./config.default.yaml";
const LOCAL_CONFIG_PATH = "./config.local.yaml";

const fileConfigDefaults = {
    attachmentDownloader: {
        // TODO: default should be extended based on platform (e.g. %TEMP% on Windows)
        /** Temp directory for streaming attachments to disk before Gemini upload. */
        tempDir: "/var/tmp/genie-attachments",
        /** Timeout in ms for receiving the initial HTTP response when downloading Discord attachments. */
        timeoutMs: 10_000,
        /** Per-download size limit for the in-memory (base64) downloader. */
        memory: { maxSizeMB: 100 },
        /** Per-download size limit for the disk-streaming downloader. */
        disk: { maxSizeMB: 1_000 },
    },
    /**
     * Global fallback timeout for all model invocations (ms).
     * Superseded by per-model agent.*.timeoutMs when set.
     */
    globalModelTimeoutMs: 10 * 60 * 1000,
    geminiFileApi: {
        /** How long to wait between file state polls when a file is in PROCESSING state (ms). */
        pollIntervalMs: 5_000,
        /** Maximum total time to wait for a file to reach ACTIVE state before throwing (ms). */
        maxPollWaitMs: 120_000,
        /** Refresh Gemini files when less than this many minutes of their 48h TTL remains. */
        fileStaleBeforeExpiryMinutes: 15,
    },
    discord: {
        /** Maximum number of messages to walk when fetching a Discord reply chain. */
        defaultChainLimit: 100,
        /** Number of retry attempts granted to a retryable bot response. */
        defaultRetriesLeft: 3,
    },
    geminiModels: {
        /** Whether to include thought tokens in model responses. Useful for debugging. */
        includeThoughts: false,
    },
    agent: {
        /**
         * How file attachments are passed to the LLM.
         * - "inline": base64-encoded directly in the message (cross-provider, high memory overhead)
         * - "upload": uploaded via Gemini Files API (Gemini only, streaming to disk)
         */
        uploadAttachmentMode: AttachmentMode.upload,
        /**
         * Maximum total size in MB for inline attachments per message and for the cumulative
         * inline attachment data across the entire conversation history.
         */
        maxInlineAttachmentSizeMB: 100,
    },
    ytDlp: {
        /** Number of proxy rotation retries on bot-detection or 429 responses. */
        retries: 1,
    },
} as const;

// ---------------------------------------------------------------------------
// File config schema
// ---------------------------------------------------------------------------

const agentModelSchema = z.object({
    model: z.string(),
    fallbackModel: z.string().optional(),
    /** Maximum milliseconds to wait for a model response before aborting. */
    timeoutMs: z.number().int().positive(),
});

const triageModelSchema = agentModelSchema.extend({
    /** Gemini reasoning effort level for the triage model. */
    thinkingLevel: z
        .string()
        .transform((v) => v.toUpperCase())
        .pipe(z.enum(THINKING_LEVELS))
        .optional()
        .prefault("LOW"),
});

const fileConfigSchema = z.object({
    attachmentDownloader: z
        .object({
            tempDir: z.string().optional().prefault(fileConfigDefaults.attachmentDownloader.tempDir),
            timeoutMs: z
                .number()
                .int()
                .positive()
                .optional()
                .prefault(fileConfigDefaults.attachmentDownloader.timeoutMs),
            memory: z
                .object({
                    maxSizeMB: z
                        .number()
                        .int()
                        .positive()
                        .optional()
                        .prefault(fileConfigDefaults.attachmentDownloader.memory.maxSizeMB),
                })
                .optional()
                .prefault(fileConfigDefaults.attachmentDownloader.memory),
            disk: z
                .object({
                    maxSizeMB: z
                        .number()
                        .int()
                        .positive()
                        .optional()
                        .prefault(fileConfigDefaults.attachmentDownloader.disk.maxSizeMB),
                })
                .optional()
                .prefault(fileConfigDefaults.attachmentDownloader.disk),
        })
        .optional()
        .prefault(fileConfigDefaults.attachmentDownloader),
    globalModelTimeoutMs: z.number().int().positive().optional().prefault(fileConfigDefaults.globalModelTimeoutMs),
    geminiFileApi: z
        .object({
            pollIntervalMs: z
                .number()
                .int()
                .positive()
                .optional()
                .prefault(fileConfigDefaults.geminiFileApi.pollIntervalMs),
            maxPollWaitMs: z
                .number()
                .int()
                .positive()
                .optional()
                .prefault(fileConfigDefaults.geminiFileApi.maxPollWaitMs),
            fileStaleBeforeExpiryMinutes: z
                .number()
                .int()
                .positive()
                .optional()
                .prefault(fileConfigDefaults.geminiFileApi.fileStaleBeforeExpiryMinutes),
        })
        .optional()
        .prefault(fileConfigDefaults.geminiFileApi),
    discord: z
        .object({
            defaultChainLimit: z
                .number()
                .int()
                .positive()
                .optional()
                .prefault(fileConfigDefaults.discord.defaultChainLimit),
            defaultRetriesLeft: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .prefault(fileConfigDefaults.discord.defaultRetriesLeft),
            previousBotId: z.string().optional(),
        })
        .optional()
        .prefault(fileConfigDefaults.discord),
    geminiModels: z
        .object({
            /** Whether to include thought tokens in model responses. Useful for debugging. */
            includeThoughts: z.boolean().optional().prefault(fileConfigDefaults.geminiModels.includeThoughts),
        })
        .optional()
        .prefault(fileConfigDefaults.geminiModels),
    agent: z.object({
        uploadAttachmentMode: z
            .string()
            .transform((v) => v.toLowerCase())
            .pipe(z.enum(ATTACHMENT_MODES))
            .optional()
            .prefault(fileConfigDefaults.agent.uploadAttachmentMode),
        maxInlineAttachmentSizeMB: z
            .number()
            .int()
            .positive()
            .optional()
            .prefault(fileConfigDefaults.agent.maxInlineAttachmentSizeMB),
        nodes: z.object({
            triage: triageModelSchema,
            general: agentModelSchema,
            search: agentModelSchema,
        }),
    }),
    ytDlp: z
        .object({
            httpProxy: z.url().optional(),
            retries: z.number().int().nonnegative().optional().prefault(fileConfigDefaults.ytDlp.retries),
        })
        .optional()
        .prefault(fileConfigDefaults.ytDlp),
});

/** Inferred type from the yaml file schema. */
export type FileConfig = z.infer<typeof fileConfigSchema>;

// ---------------------------------------------------------------------------
// Env config schema
// ---------------------------------------------------------------------------

const envConfigSchema = z
    .object({
        DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
        DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
        DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
        /**
         * Free-tier Google API keys for triage and general model rotation.
         * Comma-separated; at least one required. Keys rotate round-robin on HTTP 429.
         */
        GOOGLE_FREE_API_KEYS: z
            .string()
            .transform((raw) =>
                raw
                    .split(",")
                    .map((k) => k.trim())
                    .filter((k) => k.length > 0),
            )
            .pipe(z.string().array().min(1, "GOOGLE_FREE_API_KEYS must contain at least one API key")),
        /**
         * Paid Google API key used exclusively for the search model.
         * Google Search grounding is a paid-only feature; comma-separated values are rejected.
         */
        GOOGLE_PAID_API_KEY: z
            .string()
            .min(1, "GOOGLE_PAID_API_KEY is required (paid key for Google Search grounding)")
            .refine(
                (v) => !v.includes(","),
                "GOOGLE_PAID_API_KEY must be a single key. For multiple keys use GOOGLE_FREE_API_KEYS.",
            )
            .transform((v) => v.trim()),
    })
    .transform((env) => ({
        discordClientId: env.DISCORD_CLIENT_ID,
        discordToken: env.DISCORD_TOKEN,
        databaseUrl: env.DATABASE_URL,
        googleFreeApiKeys: env.GOOGLE_FREE_API_KEYS,
        googlePaidApiKey: env.GOOGLE_PAID_API_KEY,
    }));

/** Inferred type from the environment variable schema. */
type EnvConfig = z.infer<typeof envConfigSchema>;

// ---------------------------------------------------------------------------
// Env overrides schema
// ---------------------------------------------------------------------------

/** Optional env vars that override specific fields within the parsed file config. */
const envOverrideFileSchema = z.object({
    /** Overrides discord.previousBotId in the file config when set. */
    PREVIOUS_BOT_ID: z.string().min(1).optional(),
});

type EnvOverrideFile = z.infer<typeof envOverrideFileSchema>;

/**
 * Applies parsed env overrides onto a {@link FileConfig}, returning a new object.
 * Creates any intermediary objects that may be absent so the file config section
 * is always fully populated after the override pass.
 */
function applyEnvOverrides(fileConfig: FileConfig, overrides: EnvOverrideFile): FileConfig {
    if (overrides.PREVIOUS_BOT_ID === undefined) return fileConfig;
    return {
        ...fileConfig,
        discord: {
            ...fileConfig.discord,
            previousBotId: overrides.PREVIOUS_BOT_ID,
        },
    };
}

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

/** Typed configuration for the application. Combines env vars and yaml file config. */
export type AppConfig = EnvConfig & { file: FileConfig };

// ---------------------------------------------------------------------------
// File config loader
// ---------------------------------------------------------------------------

/**
 * Walks a plain object tree and collects dot-notation paths for any keys that
 * are not present in the corresponding node of the schema's shape tree.
 *
 * Only plain objects are recursed — arrays and primitives are not walked.
 * Used to warn about unknown/misspelled keys in the yaml config file.
 */
function collectUnknownKeys(
    value: Record<string, unknown>,
    // biome-ignore lint/suspicious/noExplicitAny: zod internal shape type is unavoidably any
    schemaShape: Record<string, any>,
    path = "",
): string[] {
    const unknown: string[] = [];
    for (const key of Object.keys(value)) {
        const fullPath = path ? `${path}.${key}` : key;
        if (!(key in schemaShape)) {
            unknown.push(fullPath);
        } else {
            const childValue = value[key];
            const childSchema = schemaShape[key];
            // Recurse into nested objects that have their own zod shape
            if (
                childValue !== null &&
                typeof childValue === "object" &&
                !Array.isArray(childValue) &&
                typeof childSchema?.shape === "object" &&
                childSchema.shape !== null
            ) {
                unknown.push(...collectUnknownKeys(childValue as Record<string, unknown>, childSchema.shape, fullPath));
            }
        }
    }
    return unknown;
}

/**
 * Parses and validates a yaml string into a {@link FileConfig}.
 *
 * If a logger is provided, warns about any keys present in the yaml that are
 * not part of the schema — guarding against typos in the config file.
 *
 * Throws {@link ConfigError} if the yaml is malformed or fails schema validation.
 * The `sourceName` parameter is used only for error messages (e.g. a file path).
 */
export function parseFileConfig(rawYaml: string, sourceName = "<config>", logger?: Logger): FileConfig {
    let parsed: unknown;
    try {
        parsed = Bun.YAML.parse(rawYaml);
    } catch (err) {
        throw new ConfigError(`Failed to parse yaml config at "${sourceName}": ${err}`);
    }

    if (logger && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const unknownKeys = collectUnknownKeys(parsed as Record<string, unknown>, fileConfigSchema.shape);
        for (const key of unknownKeys) {
            logger.warn({ key, sourceName }, `Unknown key in config file — possible typo: "${key}"`);
        }
    }

    try {
        return fileConfigSchema.parse(parsed);
    } catch (err) {
        throw new ConfigError(`Invalid config file at "${sourceName}": ${err}`);
    }
}

/**
 * Resolves which config file to load:
 * 1. CONFIG_PATH env var (explicit override)
 * 2. config.local.yaml (if it exists)
 * 3. config.default.yaml (bundled fallback)
 *
 * Reads the file and delegates parsing to {@link parseFileConfig}.
 * Throws {@link ConfigError} on read or validation failure.
 */
async function loadFileConfig(logger: Logger): Promise<FileConfig> {
    let configPath = process.env.CONFIG_PATH;

    if (!configPath) {
        const localFile = file(LOCAL_CONFIG_PATH);
        if (await localFile.exists()) {
            configPath = LOCAL_CONFIG_PATH;
        } else {
            configPath = DEFAULT_CONFIG_PATH;
            logger.warn(
                { configPath },
                "No CONFIG_PATH file or config.local.yaml found — falling back to config.default.yaml",
            );
        }
    }

    let rawText: string;
    try {
        rawText = await file(configPath).text();
    } catch {
        throw new ConfigError(`Failed to read config file at "${configPath}"`);
    }

    return parseFileConfig(rawText, configPath, logger);
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Parses and validates all required environment variables and the yaml config file.
 * Throws {@link ConfigError} immediately if any required variable is missing or
 * the config file is invalid, preventing the application from starting in a
 * misconfigured state.
 */
async function loadConfig(logger: Logger): Promise<AppConfig> {
    let envConfig: EnvConfig;
    let envOverrides: EnvOverrideFile;
    try {
        envConfig = envConfigSchema.parse(process.env);
        envOverrides = envOverrideFileSchema.parse(process.env);
    } catch (err) {
        throw new ConfigError(`Invalid environment configuration: ${err}`);
    }

    let fileConfig = await loadFileConfig(logger);

    fileConfig = applyEnvOverrides(fileConfig, envOverrides);

    return { ...envConfig, file: fileConfig };
}

// ---------------------------------------------------------------------------
// ConfigProvider
// ---------------------------------------------------------------------------

/**
 * Eagerly loads and caches the application config.
 * Call `init(logger)` once at startup; thereafter access config via `get()`.
 *
 * Encapsulates config loading so that a logger is available during parsing,
 * enabling warnings for unknown keys in the yaml file (typo guard).
 */
export class ConfigProvider {
    private static config: Promise<AppConfig> | undefined;

    constructor(private readonly logger: Logger) {
        ConfigProvider.config ??= loadConfig(this.logger);
    }

    /** Returns the config, starting the load if not already in progress. */
    async get(): Promise<AppConfig> {
        ConfigProvider.config ??= loadConfig(this.logger);
        return ConfigProvider.config;
    }
}
