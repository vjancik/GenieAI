import * as Sentry from "@sentry/bun";
import type { Integration } from "@sentry/core";

if (!process.env.SENTRY_URL) {
    throw new Error("SENTRY_URL environment variable is not set");
}

/**
 * Custom Sentry integration that wraps the global `fetch` with a Sentry span.
 *
 * Auto-instrumentation doesn't work in Bun (upstream bug), so HTTP calls made
 * via the native `fetch` are invisible in traces by default. This integration
 * patches `globalThis.fetch` to create a child span for every outgoing request,
 * recording the URL (sanitized — no query string), HTTP method, and response
 * status code as span attributes.
 *
 * Request and response bodies are intentionally omitted: they can be arbitrarily
 * large (file uploads/downloads) and may contain sensitive data, making the
 * tracing overhead unacceptable.
 *
 * Only installed when running under Bun (`process.versions.bun` is defined).
 * In Node.js the built-in `@sentry/node` HTTP instrumentation handles this.
 */
const bunFetchIntegration: Integration = {
    name: "BunFetchIntegration",
    setupOnce() {
        if (!process.versions.bun) return;

        const originalFetch = globalThis.fetch;

        async function instrumentedFetch(
            input: string | URL | Request,
            init?: RequestInit,
        ): Promise<Response> {
            // Resolve the URL string from the various allowed input types
            const url =
                input instanceof Request
                    ? input.url
                    : input instanceof URL
                      ? input.href
                      : String(input);

            // Strip query string and fragment to avoid capturing sensitive params
            const sanitizedUrl = url.split("?")[0] ?? url;
            const method = (
                (input instanceof Request ? input.method : init?.method) ??
                "GET"
            ).toUpperCase();

            return Sentry.startSpan(
                {
                    name: `${method} ${sanitizedUrl}`,
                    op: "http.client",
                    attributes: {
                        "http.request.method": method,
                        "url.full": sanitizedUrl,
                    },
                },
                async (span) => {
                    const response = await originalFetch(input as string, init);
                    span.setAttribute(
                        "http.response.status_code",
                        response.status,
                    );
                    return response;
                },
            );
        }

        // Preserve Bun-specific properties on the fetch function (e.g. `fetch.preconnect`)
        // so callers that use those extensions continue to work after the patch.
        Object.assign(instrumentedFetch, originalFetch);

        // TYPE COERCION: our wrapper matches the Bun fetch signature exactly but
        // TypeScript cannot verify the Bun-specific namespace properties are present
        // since they are copied via Object.assign above at runtime.
        globalThis.fetch = instrumentedFetch as typeof globalThis.fetch;
    },
};

Sentry.init({
    dsn: process.env.SENTRY_URL,
    // Send structured logs to Sentry
    enableLogs: true,
    // Tracing
    tracesSampleRate: 1.0, // Capture 100% of the transactions
    debug: process.env.SENTRY_DEBUG === "true" || false,
    integrations: [
        bunFetchIntegration,
        // Sentry.googleGenAIIntegration(),
        // Sentry.langChainIntegration(),
        // Sentry.langGraphIntegration(),
    ],
});

process.env.SENTRY_INITIALIZED = "true";
