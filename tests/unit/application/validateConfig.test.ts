import { describe, expect, it, mock } from "bun:test";
import pino from "pino";
import type { AppConfig } from "../../../src/application/config/AppConfig.ts";
import { AttachmentMode, SearchMode, validateConfig } from "../../../src/application/config/AppConfig.ts";
import type { Logger } from "../../../src/application/types/Logger.ts";

const testLogger = pino({ level: "silent" });

function makeLogger(): { logger: Logger; warnMock: ReturnType<typeof mock> } {
    const warnMock = mock(() => {});
    // TYPE COERCION: partial mock — only `warn` is needed by validateConfig
    const logger = { warn: warnMock } as unknown as Logger;
    return { logger, warnMock };
}

/** Minimal valid AppConfig fixture. All nodes use "free" keys, search mode is "google". */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    const base: AppConfig = {
        discordClientId: "client-id",
        discordToken: "token",
        databaseUrl: "postgres://localhost/test",
        googleFreeApiKeys: ["free-key"],
        googlePaidApiKey: null,
        tavilyApiKey: null,
        file: {
            attachmentDownloader: {
                timeoutMs: 10_000,
                memory: { maxSizeMB: 100 },
            },
            globalModelTimeoutMs: 600_000,
            geminiFileApi: {
                pollIntervalMs: 5_000,
                maxPollWaitMs: 120_000,
                fileStaleBeforeExpiryMinutes: 15,
                fileStaleBeforeExpiryMs: 15 * 60 * 1000,
            },
            discord: {
                chainLimit: 100,
                retries: 3,
                enableInDMs: false,
            },
            geminiModels: { includeThoughts: false },
            agent: {
                uploadAttachmentMode: AttachmentMode.upload,
                maxInlineAttachmentSizeMB: 100,
                maxInlineAttachmentSizeBytes: 100 * 1024 * 1024,
                nodes: {
                    triage: {
                        model: "gemini-2.5-flash",
                        timeoutMs: 60_000,
                        thinkingLevel: "LOW",
                        apiKeyType: "free",
                    },
                    general: {
                        model: "gemini-2.5-flash",
                        timeoutMs: 120_000,
                        apiKeyType: "free",
                    },
                    search: {
                        model: "gemini-2.5-flash",
                        timeoutMs: 120_000,
                        mode: SearchMode.google,
                        apiKeyType: "free",
                    },
                },
            },
            ytDlp: { retries: 1 },
        },
    };
    return { ...base, ...overrides };
}

describe("validateConfig", () => {
    it("passes for a valid free-only config", () => {
        expect(() => validateConfig(makeConfig())).not.toThrow();
    });

    it("passes for a valid paid-only config", () => {
        const config = makeConfig({
            googleFreeApiKeys: null,
            googlePaidApiKey: "paid-key",
        });
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).triage = {
            ...config.file.agent.nodes.triage,
            apiKeyType: "paid",
        };
        (config.file.agent.nodes as Record<string, unknown>).general = {
            ...config.file.agent.nodes.general,
            apiKeyType: "paid",
        };
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            apiKeyType: "paid",
        };
        expect(() => validateConfig(config)).not.toThrow();
    });

    it("throws ConfigError when a free node is configured but GOOGLE_FREE_API_KEYS is absent", () => {
        const config = makeConfig({ googleFreeApiKeys: null });
        expect(() => validateConfig(config)).toThrow(/GOOGLE_FREE_API_KEYS is required/);
    });

    it("throws ConfigError when a paid node is configured but GOOGLE_PAID_API_KEY is absent", () => {
        const config = makeConfig({ googleFreeApiKeys: null, googlePaidApiKey: null });
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).triage = {
            ...config.file.agent.nodes.triage,
            apiKeyType: "paid",
        };
        (config.file.agent.nodes as Record<string, unknown>).general = {
            ...config.file.agent.nodes.general,
            apiKeyType: "paid",
        };
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            apiKeyType: "paid",
        };
        expect(() => validateConfig(config)).toThrow(/GOOGLE_PAID_API_KEY is required/);
    });

    it("warns when search uses free key + google mode + gemini-3 primary model", () => {
        const { logger, warnMock } = makeLogger();
        const config = makeConfig();
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            model: "gemini-3-flash-preview",
            apiKeyType: "free",
            mode: SearchMode.google,
        };
        validateConfig(config, logger);
        expect(warnMock).toHaveBeenCalledTimes(1);
        expect(warnMock).toHaveBeenCalledWith(
            expect.objectContaining({ searchModel: "gemini-3-flash-preview" }),
            expect.stringContaining("Gemini 3 models do not support Google Search grounding on free-tier"),
        );
    });

    it("warns when search uses free key + google mode + gemini-3 fallback model", () => {
        const { logger, warnMock } = makeLogger();
        const config = makeConfig();
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            model: "gemini-2.5-flash",
            fallbackModel: "gemini-3-flash",
            apiKeyType: "free",
            mode: SearchMode.google,
        };
        validateConfig(config, logger);
        expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it("does not warn for free key + google mode + gemini-2.5 model", () => {
        const { logger, warnMock } = makeLogger();
        validateConfig(makeConfig(), logger);
        expect(warnMock).not.toHaveBeenCalled();
    });

    it("does not warn for paid key + google mode + gemini-3 model", () => {
        const { logger, warnMock } = makeLogger();
        const config = makeConfig({
            googleFreeApiKeys: ["free-key"],
            googlePaidApiKey: "paid-key",
        });
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            model: "gemini-3-flash-preview",
            apiKeyType: "paid",
            mode: SearchMode.google,
        };
        validateConfig(config, logger);
        expect(warnMock).not.toHaveBeenCalled();
    });

    it("does not warn for free key + tavily mode + gemini-3 model", () => {
        const { logger, warnMock } = makeLogger();
        const config = makeConfig();
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            model: "gemini-3-flash-preview",
            apiKeyType: "free",
            mode: SearchMode.tavily,
        };
        validateConfig(config, logger);
        expect(warnMock).not.toHaveBeenCalled();
    });

    it("does not warn when no logger is provided", () => {
        const config = makeConfig();
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).search = {
            ...config.file.agent.nodes.search,
            model: "gemini-3-flash-preview",
            apiKeyType: "free",
            mode: SearchMode.google,
        };
        // Should not throw even though the combination is problematic
        expect(() => validateConfig(config)).not.toThrow();
    });

    it("throws ConfigError when upload mode is used with a non-Gemini model", () => {
        const config = makeConfig();
        // TYPE COERCION: deep-merging nodes into a readonly nested object requires a cast
        (config.file.agent.nodes as Record<string, unknown>).general = {
            ...config.file.agent.nodes.general,
            model: "gpt-4o",
        };
        expect(() => validateConfig(config)).toThrow(/Upload attachment mode requires Gemini models/);
    });
});
