import path from "node:path";
import pino from "pino";

/**
 * Re-export pino's Logger type for use throughout the application.
 * Injecting this type enables easy mocking in tests.
 */
export type Logger = pino.Logger;

/**
 * Formats a Date as a filesystem-safe ISO-like timestamp string.
 * Colons and dots are replaced with dashes to avoid issues on Windows and in filenames.
 * Example: "2026-03-07T12-00-00-000Z"
 */
function formatTimestamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Creates a configured Pino logger instance.
 *
 * In non-production environments, uses pino-pretty for human-readable output.
 * When fileLog is true, also writes structured JSON logs to
 * `./logs/<process-start-timestamp>-pino.log` in parallel with the console transport.
 *
 * @param logLevel - The minimum log level to output (e.g. "info", "debug")
 * @param fileLog  - Whether to additionally write logs to a file (default: false)
 */
export function createLogger(logLevel: string, fileLog = false): Logger {
    const isProduction = process.env.NODE_ENV === "production";

    if (!fileLog) {
        // No file transport — original behavior.
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

    // Build the log file path: <project-root>/logs/<timestamp>-pino.log
    const timestamp = formatTimestamp(new Date());
    const logDir = path.resolve(import.meta.dir, "../../../logs");
    const logFile = path.join(logDir, `${timestamp}-pino.log`);

    if (isProduction) {
        // Production: structured JSON to stdout + file in parallel.
        return pino(
            { level: logLevel },
            pino.transport({
                targets: [
                    // fd 1 = stdout — keeps the existing JSON-to-stdout behaviour
                    {
                        target: "pino/file",
                        options: { destination: 1 },
                        level: logLevel,
                    },
                    {
                        target: "pino/file",
                        options: { destination: logFile, mkdir: true },
                        level: logLevel,
                    },
                ],
            }),
        );
    }

    // Development: pino-pretty to stdout + structured JSON to file.
    return pino(
        { level: logLevel },
        pino.transport({
            targets: [
                {
                    target: "pino-pretty",
                    options: { colorize: true },
                    level: logLevel,
                },
                {
                    target: "pino/file",
                    options: { destination: logFile, mkdir: true },
                    level: logLevel,
                },
            ],
        }),
    );
}
