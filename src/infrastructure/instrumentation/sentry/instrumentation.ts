import * as Sentry from "@sentry/bun";

if (!process.env.SENTRY_URL) {
    throw new Error("SENTRY_URL environment variable is not set");
}

Sentry.init({
    dsn: process.env.SENTRY_URL,
    // Send structured logs to Sentry
    enableLogs: true,
    // Tracing
    tracesSampleRate: 1.0, // Capture 100% of the transactions
    debug: process.env.SENTRY_DEBUG === "true" || false,
    integrations: [
        // Sentry.googleGenAIIntegration(),
        // Sentry.langChainIntegration(),
        // Sentry.langGraphIntegration(),
    ],
});

process.env.SENTRY_INITIALIZED = "true";

// Sentry.logger.info("Sentry instrumentation initialized");
