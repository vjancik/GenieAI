import { logger as SentryLogger } from "@sentry/bun";
import type { Logger } from "pino";

/** Pino log-level method names that map 1-to-1 to Sentry logger methods. */
const LOG_LEVELS = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Wraps a Pino logger instance with a transparent `Proxy` that forwards every
 * log call to the Sentry structured logging API (`Sentry.logger.*`) in addition
 * to the underlying Pino logger.
 *
 * Motivation: the JSON serialize → worker → deserialize path used by file-based
 * Pino transports is unnecessary overhead for an in-process sink. This proxy
 * intercepts the call arguments directly, avoiding any serialization.
 *
 * Behavior:
 * - All six standard log levels (`trace`…`fatal`) are intercepted and mirrored
 *   to the matching `SentryLogger.*` method.
 * - `child()` is intercepted so that child loggers are also wrapped, preserving
 *   the Sentry forwarding through the full logger hierarchy.
 * - Level filtering: Sentry is only called when the level is enabled on the
 *   underlying logger (`pinoLogger.isLevelEnabled`), so Sentry never receives
 *   log records that Pino itself would have suppressed.
 * - The return type is the same `Logger` type — callers see no difference.
 *
 * Only used when running under Bun (`process.versions.bun` is defined).
 * In Node.js, a proper OpenTelemetry transport handles this at the SDK level.
 */
export function withSentryLogging(pinoLogger: Logger): Logger {
    return new Proxy(pinoLogger, {
        get(target, prop, receiver) {
            const level = prop as LogLevel;

            if (LOG_LEVELS.includes(level)) {
                // Return a wrapper function that calls both Pino and Sentry
                return (...args: Parameters<Logger[LogLevel]>) => {
                    // Call the original Pino method first
                    (target[level] as (...a: unknown[]) => void)(...args);

                    // Only forward to Sentry if this level is enabled
                    if (!target.isLevelEnabled(level)) return;

                    // Normalize args: Pino accepts (msg), (obj, msg) or (obj)
                    const [first, second] = args;
                    if (typeof first === "string") {
                        // logger.info("message") — no structured object
                        SentryLogger[level](first);
                    } else if (first !== null && typeof first === "object") {
                        const msg = typeof second === "string" ? second : "";
                        // TYPE COERCION: Pino accepts any object as bindings; Sentry
                        // expects Record<string, string | number | boolean>. The values
                        // in Pino bindings are typically primitives in our codebase.
                        SentryLogger[level](
                            msg,
                            first as Record<string, string | number | boolean>,
                        );
                    }
                };
            }

            if (prop === "child") {
                // Wrap child loggers so they also forward to Sentry
                return (bindings: object, options?: object) => {
                    const child = target.child(bindings, options);
                    return withSentryLogging(child);
                };
            }

            return Reflect.get(target, prop, receiver);
        },
    });
}
