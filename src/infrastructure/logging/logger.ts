import path from "node:path";
import pino from "pino";
import type { Logger } from "../../application/types/Logger.ts";
import { withSentryLogging } from "./withSentryLogging.ts";

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
 * When Sentry has been initialized (SENTRY_INITIALIZED=true) and running under
 * Bun, the returned logger is wrapped with {@link withSentryLogging}, which
 * forwards every log call to `Sentry.logger.*` without any JSON serialization
 * overhead.
 *
 * @param logLevel - The minimum log level to output (e.g. "info", "debug")
 * @param fileLog  - Whether to additionally write logs to a file (default: false)
 */
export function createLogger(logLevel: string, fileLog = false): Logger {
    const isProduction = process.env.NODE_ENV === "production";

    if (!fileLog) {
        // No file transport — original behavior.
        const logger = pino({
            level: logLevel,
            transport: isProduction
                ? undefined
                : {
                      target: "pino-pretty",
                      options: { colorize: true },
                  },
        });
        return maybeWrapWithSentry(logger);
    }

    // Build the log file path: <project-root>/logs/<timestamp>-pino.log
    const timestamp = formatTimestamp(new Date());
    const logDir = path.resolve(import.meta.dir, "../../../logs");
    const logFile = path.join(logDir, `${timestamp}-pino.log`);

    // TYPE COERCION: the targets array holds heterogeneous options shapes
    // (destination: string vs number, colorize, mkdir) that don't unify under
    // pino's generic TransportTargetOptions<T>. Casting via unknown to the
    // multi-target overload is safe — pino.transport serializes options as-is.
    const logger = pino(
        { level: logLevel },
        pino.transport({
            targets: isProduction
                ? [
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
                  ]
                : [
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
        } as unknown as pino.TransportMultiOptions),
    );

    return maybeWrapWithSentry(logger);
}

/**
 * Wraps the logger with Sentry forwarding when conditions are met:
 * running under Bun and Sentry has been initialized before the logger was created.
 */
function maybeWrapWithSentry(logger: Logger): Logger {
    if (process.versions.bun && process.env.SENTRY_INITIALIZED === "true") {
        return withSentryLogging(logger);
    }
    return logger;
}
