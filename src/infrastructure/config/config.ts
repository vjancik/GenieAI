import { ConfigError } from "../../domain/errors/AppError.ts";

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
    /** Pino log level. Default: "info" */
    logLevel: string;
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
        logLevel: process.env.LOG_LEVEL ?? "info",
    };
}

export const config: AppConfig = loadConfig();
