import { file } from "bun";
import { z } from "zod";
import { ConfigError } from "../../domain/errors/AppError.ts";
import type { RateLimitWindow } from "../ports/IRateLimiter.ts";
import type { Logger } from "../types/Logger.ts";
import { THINKING_LEVELS } from "../types/ThinkingLevel.ts";

/**
 * Controls which API key pool is used when invoking an agent node.
 * - "free": round-robin rotation over the free key pool (GOOGLE_FREE_API_KEYS)
 * - "paid": round-robin rotation over the paid key pool (GOOGLE_PAID_API_KEYS)
 */
export const ApiKeyType = {
    free: "free",
    paid: "paid",
} as const;

export type ApiKeyType = (typeof ApiKeyType)[keyof typeof ApiKeyType];

const API_KEY_TYPES = Object.values(ApiKeyType) as readonly ApiKeyType[];

/** Controls how file attachments are included in LLM requests. */
export const AttachmentMode = {
    inline: "inline",
    upload: "upload",
} as const;

export type AttachmentMode = (typeof AttachmentMode)[keyof typeof AttachmentMode];

const ATTACHMENT_MODES = Object.values(AttachmentMode) as readonly AttachmentMode[];

/**
 * Controls which search backend is used.
 * - "google": Google Search grounding via the Gemini API (requires a paid API key;
 *   only free for gemini-2.5 models — gemini-3+ requires a paid plan). Answered by the
 *   googleSearch node.
 * - "tavily": Tavily Search API (requires TAVILY_API_KEY env var). Runs as a tool, with the
 *   general node answering from the results.
 */
export const SearchMode = {
    google: "google",
    tavily: "tavily",
} as const;

export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

const SEARCH_MODES = Object.values(SearchMode) as readonly SearchMode[];

/**
 * Controls how a node's fallback model is used alongside its main model.
 * - "sequential": the fallback is invoked only after the main model fails with a 503 or timeout.
 * - "parallel": both models are invoked at once; the main model's answer is preferred, but a
 *   successful fallback answer is used once the node's `mainGracePeriodMs` runs out.
 */
export const FallbackExecutionMode = {
    sequential: "sequential",
    parallel: "parallel",
} as const;

export type FallbackExecutionMode = (typeof FallbackExecutionMode)[keyof typeof FallbackExecutionMode];

const FALLBACK_EXECUTION_MODES = Object.values(FallbackExecutionMode) as readonly FallbackExecutionMode[];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = "./config.default.yaml";
const LOCAL_CONFIG_PATH = "./config.local.yaml";

export const BASE_PROMPT_DEFAULT =
    "You are an AI assistant. You answer questions in a friendly and informative manner.\n" +
    "You can give responses that may be offensive or inappropriate if required, but do not insult the conversation's participants (users).\n" +
    "You do not take insults personally. Do not express outrage or overtly negative or antisocial attitudes.\n" +
    "Your answer should be shorter than 1500 characters.\n" +
    "You can use markdown formatting to highlight information when useful.";

/**
 * Default per-user message rate limits: 3 per 3 seconds and 10 per minute.
 * Declared outside the `as const` defaults so it stays a mutable array, which zod's `prefault` requires.
 */
const DEFAULT_RATE_LIMITS: RateLimitWindow[] = [
    { windowMs: 3_000, limit: 3 },
    { windowMs: 60_000, limit: 10 },
];

/**
 * Token rate limiting is disabled by default (no windows). Declared outside the `as const`
 * defaults so it stays a mutable array, which zod's `prefault` requires.
 */
const DEFAULT_TOKEN_RATE_LIMIT_WINDOWS: RateLimitWindow[] = [];

const fileConfigDefaults = {
    prompts: {
        basePrompt: BASE_PROMPT_DEFAULT,
    },
    attachmentDownloader: {
        /** Timeout in ms for receiving the initial HTTP response when downloading Discord attachments. */
        timeoutMs: 10_000,
        /** Per-download size limit for the in-memory downloader. */
        memory: { maxSizeMB: 100 },
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
        fileStaleBeforeExpiryMinutes: 30,
    },
    cache: {
        /** Maximum number of resolved Gemini fileUri entries to keep in the in-process LRU cache. */
        geminiFileUrls: 1000,
    },
    discord: {
        /** Maximum number of messages to walk when fetching a Discord reply chain. */
        chainLimit: 100,
        /** Number of retry attempts granted to a retryable bot response. */
        retries: 3,
        /** Whether the bot responds to messages and commands in Direct Message channels. */
        enableInDMs: false,
        /**
         * Per-user sliding-window limits on messages addressed to the bot. A message is allowed
         * only when every window has capacity left. An empty list disables rate limiting.
         */
        rateLimits: DEFAULT_RATE_LIMITS,
        /**
         * Per-user sliding-window limits on weighted model token usage. Each finished request is charged
         * `input_tokens - cache_read + cache_read * cachedTokensWeight + output_tokens * outputTokensWeight`,
         * read from the final model response; a user is refused once any window's total reaches its limit.
         */
        tokenRateLimits: {
            /** Multiplier for cached input tokens, 0 to 1. */
            cachedTokensWeight: 0.1,
            /** Multiplier for output (including thinking) tokens, 0 to 10. */
            outputTokensWeight: 5,
            /** Windows to enforce; empty disables token rate limiting. */
            windows: DEFAULT_TOKEN_RATE_LIMIT_WINDOWS,
        },
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
        /**
         * Maximum size in MB of a file loaded from a URL in the user's message.
         * Only applies in "upload" attachment mode, the only mode that loads such files.
         */
        maxExternalUrlFileSizeMB: 500,
        /** How fallback models are run alongside main models ("sequential" or "parallel"). */
        fallbackExecutionMode: FallbackExecutionMode.sequential,
        /** Which search backend answers requests that need current information. */
        searchMode: SearchMode.google,
    },
    externalContent: {
        /**
         * Only fetch HTTPS URLs from what users supply (website and video captions tools, and
         * the redirects the website tool follows). Discord media is not affected.
         */
        httpsOnly: true,
        /** Refuse user-supplied URLs whose host resolves to a private, loopback or link-local address. */
        blockPrivateAddresses: true,
        /**
         * Rewrite plain HTTP URLs that users supply to HTTPS when the host serves HTTPS with a
         * valid certificate. Redirects are not rewritten. Runs before the HTTPS-only check.
         */
        rewriteHttp: true,
    },
    ytDlp: {
        /** Number of proxy rotation retries on bot-detection or 429 responses. */
        retries: 1,
        /** Hard cap in milliseconds on a whole captions tool call, including all retries. */
        timeoutMs: 5 * 60 * 1000,
    },
} as const;

// ---------------------------------------------------------------------------
// File config schema
// ---------------------------------------------------------------------------

const rateLimitWindowSchema = z.object({
    /** Duration of the sliding window in milliseconds. */
    windowMs: z.number().int().positive(),
    /** Maximum number of messages allowed within the window. */
    limit: z.number().int().positive(),
});

const agentModelSchema = z.object({
    model: z.string(),
    fallbackModel: z.string().optional(),
    /** Maximum milliseconds to wait for a model response before aborting. */
    timeoutMs: z.number().int().positive(),
    /**
     * Parallel fallback mode only (no-op in sequential mode): how many milliseconds the main
     * model is given to finish after the fallback model has answered cleanly. A clean main answer
     * arriving within this window is preferred; otherwise the fallback answer is used.
     * Required in parallel mode for nodes with a `fallbackModel`, treated as 0 when absent.
     */
    mainGracePeriodMs: z.number().int().nonnegative().optional(),
    /** Which API key pool to use when invoking this node ("free" or "paid"). */
    apiKeyType: z
        .string()
        .transform((v) => v.toLowerCase())
        .pipe(z.enum(API_KEY_TYPES)),
});

/**
 * Schema for the nodes that generate the user-facing answer (general, computation, googleSearch).
 * Triage only routes, so answer-quality settings do not apply to it.
 */
const answerNodeModelSchema = agentModelSchema.extend({
    /**
     * Whether a response generated by the fallback model is offered a Retry.
     * Set to false when the fallback is an alternative rather than a downgrade, so its answers
     * are treated as final. Interrupted or abnormally stopped responses stay retryable regardless.
     * Defaults to true.
     */
    isFallbackRetryable: z.boolean().prefault(true),
});

const triageModelSchema = agentModelSchema.extend({
    /** Gemini reasoning effort level for the triage model. */
    thinkingLevel: z
        .string()
        .transform((v) => v.toUpperCase())
        .pipe(z.enum(THINKING_LEVELS))

        .prefault("LOW"),
});

const fileConfigSchema = z.object({
    prompts: z
        .object({
            /** Base system prompt prepended to all agent system prompts. */
            basePrompt: z.string().prefault(fileConfigDefaults.prompts.basePrompt),
        })

        .prefault(fileConfigDefaults.prompts),
    attachmentDownloader: z
        .object({
            timeoutMs: z
                .number()
                .int()
                .positive()

                .prefault(fileConfigDefaults.attachmentDownloader.timeoutMs),
            memory: z
                .object({
                    maxSizeMB: z
                        .number()
                        .int()
                        .positive()

                        .prefault(fileConfigDefaults.attachmentDownloader.memory.maxSizeMB),
                })

                .prefault(fileConfigDefaults.attachmentDownloader.memory),
        })

        .prefault(fileConfigDefaults.attachmentDownloader),
    globalModelTimeoutMs: z.number().int().positive().prefault(fileConfigDefaults.globalModelTimeoutMs),
    geminiFileApi: z
        .object({
            pollIntervalMs: z
                .number()
                .int()
                .positive()

                .prefault(fileConfigDefaults.geminiFileApi.pollIntervalMs),
            maxPollWaitMs: z
                .number()
                .int()
                .positive()

                .prefault(fileConfigDefaults.geminiFileApi.maxPollWaitMs),
            fileStaleBeforeExpiryMinutes: z
                .number()
                .int()
                .positive()

                .prefault(fileConfigDefaults.geminiFileApi.fileStaleBeforeExpiryMinutes),
        })

        .prefault(fileConfigDefaults.geminiFileApi),
    cache: z
        .object({
            geminiFileUrls: z.number().int().nonnegative().prefault(fileConfigDefaults.cache.geminiFileUrls),
        })

        .prefault(fileConfigDefaults.cache),
    discord: z
        .object({
            chainLimit: z.number().int().positive().prefault(fileConfigDefaults.discord.chainLimit),
            retries: z.number().int().nonnegative().prefault(fileConfigDefaults.discord.retries),
            enableInDMs: z.boolean().prefault(fileConfigDefaults.discord.enableInDMs),
            rateLimits: z.array(rateLimitWindowSchema).prefault(fileConfigDefaults.discord.rateLimits),
            tokenRateLimits: z
                .object({
                    cachedTokensWeight: z
                        .number()
                        .min(0)
                        .max(1)
                        .prefault(fileConfigDefaults.discord.tokenRateLimits.cachedTokensWeight),
                    outputTokensWeight: z
                        .number()
                        .min(0)
                        .max(10)
                        .prefault(fileConfigDefaults.discord.tokenRateLimits.outputTokensWeight),
                    windows: z
                        .array(rateLimitWindowSchema)
                        .prefault(fileConfigDefaults.discord.tokenRateLimits.windows),
                })
                .prefault(fileConfigDefaults.discord.tokenRateLimits),
            previousBotId: z.string().optional(),
        })

        .prefault(fileConfigDefaults.discord),
    externalContent: z
        .object({
            httpsOnly: z.boolean().prefault(fileConfigDefaults.externalContent.httpsOnly),
            blockPrivateAddresses: z.boolean().prefault(fileConfigDefaults.externalContent.blockPrivateAddresses),
            rewriteHttp: z.boolean().prefault(fileConfigDefaults.externalContent.rewriteHttp),
        })

        .prefault(fileConfigDefaults.externalContent),
    geminiModels: z
        .object({
            /** Whether to include thought tokens in model responses. Useful for debugging. */
            includeThoughts: z.boolean().prefault(fileConfigDefaults.geminiModels.includeThoughts),
        })

        .prefault(fileConfigDefaults.geminiModels),
    agent: z.object({
        uploadAttachmentMode: z
            .string()
            .transform((v) => v.toLowerCase())
            .pipe(z.enum(ATTACHMENT_MODES))

            .prefault(fileConfigDefaults.agent.uploadAttachmentMode),
        maxInlineAttachmentSizeMB: z
            .number()
            .int()
            .positive()

            .prefault(fileConfigDefaults.agent.maxInlineAttachmentSizeMB),
        maxExternalUrlFileSizeMB: z
            .number()
            .int()
            .positive()

            .prefault(fileConfigDefaults.agent.maxExternalUrlFileSizeMB),
        /**
         * Largest input in tokens a single model call may send, counted by the Gemini tokenizer
         * right before the call. Larger inputs are rejected with a message to the user. Optional,
         * no default: when unset, inputs are not counted or limited.
         */
        maxInputTokens: z.number().int().positive().optional(),
        fallbackExecutionMode: z
            .string()
            .transform((v) => v.toLowerCase())
            .pipe(z.enum(FALLBACK_EXECUTION_MODES))

            .prefault(fileConfigDefaults.agent.fallbackExecutionMode),
        /**
         * Which search backend to use.
         * - "google": Google Search grounding via the Gemini API (requires a paid key;
         *   free only for gemini-2.5 models — gemini-3+ requires a paid plan). Search requests
         *   are answered by the googleSearch node.
         * - "tavily": Tavily Search API (requires TAVILY_API_KEY env var). Searches run as a
         *   tool and their results are answered from by the general node.
         * Defaults to "google".
         */
        searchMode: z
            .string()
            .transform((v) => v.toLowerCase())
            .pipe(z.enum(SEARCH_MODES))

            .prefault(fileConfigDefaults.agent.searchMode),
        nodes: z.object({
            triage: triageModelSchema,
            general: answerNodeModelSchema,
            computation: answerNodeModelSchema,
            /** Only used when `searchMode` is "google": the model with Google Search grounding. */
            googleSearch: answerNodeModelSchema,
        }),
    }),
    ytDlp: z
        .object({
            httpProxy: z.url().optional(),
            retries: z.number().int().nonnegative().prefault(fileConfigDefaults.ytDlp.retries),
            timeoutMs: z.number().int().positive().prefault(fileConfigDefaults.ytDlp.timeoutMs),
        })

        .prefault(fileConfigDefaults.ytDlp),
});

/** Inferred type from the yaml file schema. */
export type FileConfig = z.infer<typeof fileConfigSchema>;

// ---------------------------------------------------------------------------
// Env config schema
// ---------------------------------------------------------------------------

/** Parses a comma-separated list of API keys, trimming whitespace and dropping empty entries. */
const commaSeparatedKeysSchema = z
    .string()
    .transform((raw) =>
        raw
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k.length > 0),
    )
    .pipe(z.string().array());

const envConfigSchema = z
    .object({
        DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
        DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
        DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
        /**
         * Free-tier Google API keys for triage and general model rotation.
         * Comma-separated. Required when any agent node uses apiKeyType "free".
         * Keys rotate round-robin when a key is rejected (HTTP 401, 402, 403) or rate-limited (HTTP 429).
         */
        GOOGLE_FREE_API_KEYS: commaSeparatedKeysSchema.optional(),
        /**
         * Paid Google API keys. Comma-separated. Required when any agent node uses apiKeyType "paid".
         * Google Search grounding is a paid-only feature.
         * Keys are used in the listed order, rotating to the next one when a key is rejected
         * (HTTP 401, 402, 403) or rate-limited (HTTP 429).
         */
        GOOGLE_PAID_API_KEYS: commaSeparatedKeysSchema.optional(),
        /**
         * Tavily Search API key — required when agent.searchMode is "tavily".
         * Obtain a key at https://tavily.com.
         */
        TAVILY_API_KEY: z
            .string()
            .min(1)
            .transform((v) => v.trim())
            .optional(),
    })
    .transform((env) => ({
        discordClientId: env.DISCORD_CLIENT_ID,
        discordToken: env.DISCORD_TOKEN,
        databaseUrl: env.DATABASE_URL,
        googleFreeApiKeys: env.GOOGLE_FREE_API_KEYS ?? null,
        googlePaidApiKeys: env.GOOGLE_PAID_API_KEYS ?? null,
        tavilyApiKey: env.TAVILY_API_KEY ?? null,
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

/**
 * Extends the parsed `file.agent` schema with pre-computed derived values
 * nested alongside their source fields.
 */
type FileAgentConfigWithComputed = FileConfig["agent"] & {
    /** `maxInlineAttachmentSizeMB` converted to bytes. */
    maxInlineAttachmentSizeBytes: number;
    /** `maxExternalUrlFileSizeMB` converted to bytes. */
    maxExternalUrlFileSizeBytes: number;
};

/**
 * Extends the parsed `file.geminiFileApi` schema with pre-computed derived values
 * nested alongside their source fields.
 */
type FileGeminiApiConfigWithComputed = FileConfig["geminiFileApi"] & {
    /** Stale threshold in ms: Gemini 48h TTL minus `fileStaleBeforeExpiryMinutes`. */
    fileStaleBeforeExpiryMs: number;
};

/**
 * {@link FileConfig} with pre-computed derived values mixed into the nested
 * objects they derive from. Centralises conversions (MB → bytes, minutes → ms)
 * so no consumer performs them ad-hoc.
 */
type FileConfigWithComputed = Omit<FileConfig, "agent" | "geminiFileApi"> & {
    agent: FileAgentConfigWithComputed;
    geminiFileApi: FileGeminiApiConfigWithComputed;
};

/** Typed configuration for the application. Combines env vars and yaml file config. */
export type AppConfig = EnvConfig & { file: FileConfigWithComputed };

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
function collectUnknownKeys(value: Record<string, unknown>, schemaShape: Record<string, unknown>, path = ""): string[] {
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
                childSchema !== null &&
                typeof childSchema === "object" &&
                "shape" in childSchema &&
                childSchema.shape !== null &&
                typeof childSchema.shape === "object"
            ) {
                unknown.push(
                    ...collectUnknownKeys(
                        childValue as Record<string, unknown>,
                        childSchema.shape as Record<string, unknown>,
                        fullPath,
                    ),
                );
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
// Computed values
// ---------------------------------------------------------------------------

/**
 * Extends a parsed config object with pre-computed derived values, nested
 * alongside their source fields. Mutates in place via type cast to avoid
 * an unnecessary object copy.
 */
function applyComputedValues(config: EnvConfig & { file: FileConfig }): AppConfig {
    // TYPE COERCION: casting to AppConfig to assign computed fields onto the
    // existing nested objects in place, avoiding unnecessary spreads/copies.
    const out = config as AppConfig;
    out.file.agent.maxInlineAttachmentSizeBytes = config.file.agent.maxInlineAttachmentSizeMB * 1024 * 1024;
    out.file.agent.maxExternalUrlFileSizeBytes = config.file.agent.maxExternalUrlFileSizeMB * 1024 * 1024;
    out.file.geminiFileApi.fileStaleBeforeExpiryMs = config.file.geminiFileApi.fileStaleBeforeExpiryMinutes * 60 * 1000;
    return out;
}

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

/**
 * Validates cross-field constraints on a fully-constructed {@link AppConfig}.
 *
 * Separates compatibility checks from schema parsing so that they run after
 * computed values are applied and can be unit-tested independently.
 *
 * Throws {@link ConfigError} if any hard constraint is violated.
 * Logs warnings for non-fatal but likely-misconfigured combinations.
 */
export function validateConfig(config: AppConfig, logger?: Logger): void {
    const { nodes, searchMode } = config.file.agent;

    // The googleSearch node never runs in Tavily mode, so its settings impose no requirements there.
    const activeNodes = Object.entries(nodes).filter(
        ([name]) => name !== "googleSearch" || searchMode === SearchMode.google,
    );

    // Ensure required API key env vars are present for the configured node apiKeyTypes.
    const needsFree = activeNodes.some(([, node]) => node.apiKeyType === ApiKeyType.free);
    const needsPaid = activeNodes.some(([, node]) => node.apiKeyType === ApiKeyType.paid);
    if (needsFree && !config.googleFreeApiKeys?.length) {
        throw new ConfigError(
            'GOOGLE_FREE_API_KEYS is required because one or more agent nodes use apiKeyType: "free"',
        );
    }
    if (needsPaid && !config.googlePaidApiKeys?.length) {
        throw new ConfigError(
            'GOOGLE_PAID_API_KEYS is required because one or more agent nodes use apiKeyType: "paid"',
        );
    }

    // In parallel mode the grace period decides when a fallback answer wins, and suitable values
    // vary widely with each node's task complexity, so it must be set explicitly per node.
    if (config.file.agent.fallbackExecutionMode === FallbackExecutionMode.parallel) {
        const missingGracePeriod = activeNodes
            .filter(([, node]) => node.fallbackModel !== undefined && node.mainGracePeriodMs === undefined)
            .map(([name]) => `agent.nodes.${name}.mainGracePeriodMs`);
        if (missingGracePeriod.length > 0) {
            throw new ConfigError(
                'agent.fallbackExecutionMode is "parallel", which requires a grace period on every active node ' +
                    `with a fallbackModel. Missing: ${missingGracePeriod.join(", ")}`,
            );
        }
    }

    // Warn when search is configured with free keys + Google grounding + a Gemini 3 model,
    // because the Ground with Google Search quota is zero for free-tier on Gemini 3+.
    const googleSearch = nodes.googleSearch;
    if (logger && googleSearch.apiKeyType === ApiKeyType.free && searchMode === SearchMode.google) {
        const searchModels = [googleSearch.model, googleSearch.fallbackModel].filter(Boolean) as string[];
        const hasGemini3Plus = searchModels.some((m) => m.startsWith("gemini-3") || m.startsWith("gemini-4"));
        if (hasGemini3Plus) {
            logger.warn(
                {
                    searchModel: googleSearch.model,
                    fallbackModel: googleSearch.fallbackModel,
                    searchMode,
                    apiKeyType: googleSearch.apiKeyType,
                },
                "Gemini 3+ models do not support Google Search grounding on free-tier keys " +
                    "(Ground with Google Search quota is 0 for free tier on gemini-3+). " +
                    'Switch agent.searchMode to "tavily" or use a gemini-2.5 model.',
            );
        }
    }

    if (config.file.agent.uploadAttachmentMode !== AttachmentMode.upload) return;

    // Upload mode uses the Gemini Files API, which is only supported by Gemini models.
    const providers = activeNodes.map(([name, node]) => ({ name: `agent.nodes.${name}.model`, model: node.model }));
    for (const { name, model } of providers) {
        if (!model.startsWith("gemini")) {
            throw new ConfigError(`Upload attachment mode requires Gemini models, but "${name}" is set to: ${model}`);
        }
    }
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

    const config = applyComputedValues({ ...envConfig, file: fileConfig });
    validateConfig(config, logger);
    return config;
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
