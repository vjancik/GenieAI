import pino from "pino";

/**
 * Re-export pino's Logger type for use throughout the application.
 * Injecting this type enables easy mocking in tests.
 */
export type Logger = pino.Logger;

/**
 * Creates a configured Pino logger instance.
 *
 * In non-production environments, uses pino-pretty for human-readable output.
 * The log level is driven by the LOG_LEVEL environment variable (default: "info").
 *
 * @param logLevel - The minimum log level to output
 */
export function createLogger(logLevel: string): Logger {
    const isProduction = process.env.NODE_ENV === "production";

    return pino({
        level: logLevel,
        transport: isProduction
            ? undefined
            : {
                  target: "pino-pretty",
                  options: { colorize: true },
              },
    });
}
