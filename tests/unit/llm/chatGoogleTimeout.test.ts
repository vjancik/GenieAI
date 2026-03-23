/**
 * Regression test: ChatGoogle must respect RunnableConfig.timeout on the
 * non-streaming invoke() path.
 *
 * Fixed in @langchain/google@0.1.8 — the non-streaming `_generate` code path
 * previously dropped the AbortSignal produced by `RunnableConfig.timeout`,
 * causing stalled API calls to hang forever.
 *
 * @see docs/upstream_bugs/langchain-google-non-streaming-invoke-ignores-timeout.md
 *
 * ## Proxy design
 *
 * The fetch proxy only intercepts `generateContent` URLs and honours the
 * `signal` from the caller's RequestInit so that an abort propagates
 * immediately. All other URLs (e.g. LangSmith health checks) pass through.
 */

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google";

const FAKE_API_KEY = "test-api-key-fake-timeout-test";

/**
 * Installs a global fetch proxy that hangs indefinitely on `generateContent`
 * requests, honouring the `signal` from the caller's RequestInit so that an
 * abort propagates immediately. All other requests pass through unchanged.
 *
 * Returns a cleanup function that restores the original fetch.
 */
function installHangingFetchProxy(): () => void {
    const originalFetch = globalThis.fetch;

    // TYPE COERCION: our mock omits the `preconnect` property on the fetch
    // function object, which is only relevant in browser contexts. Casting
    // avoids polluting the mock with a no-op stub.
    globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
        const url = input instanceof Request ? input.url : typeof input === "string" ? input : input.toString();

        if (url.includes("generateContent")) {
            // Pull signal from either the RequestInit or the Request object.
            // This is the critical pass-through: the library must wire the timeout
            // AbortSignal into the request so the proxy can honour it.
            const signal: AbortSignal | null | undefined =
                init?.signal ?? (input instanceof Request ? input.signal : undefined);

            return new Promise<Response>((_resolve, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                signal?.addEventListener("abort", () => {
                    reject(signal.reason);
                });
                // Intentionally never resolve — simulates a stalled API call.
            });
        }

        return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    return () => {
        globalThis.fetch = originalFetch;
    };
}

const TIMEOUT_MS = 500;
const GRACE_MS = 300;

describe("ChatGoogle — RunnableConfig.timeout", () => {
    /**
     * invoke() must reject with a timeout-like error within the configured
     * deadline when the API stalls. The AbortSignal must be forwarded into
     * the fetch call so the proxy can honour it.
     *
     * If this test starts failing (invoke hangs again), the upstream bug has
     * regressed — check @langchain/google's _generate non-streaming branch.
     *
     * @see docs/upstream_bugs/langchain-google-non-streaming-invoke-ignores-timeout.md
     */
    test(
        "invoke() rejects within deadline when the API stalls",
        async () => {
            const restore = installHangingFetchProxy();

            const model = new ChatGoogle({
                model: "gemini-2.5-flash",
                apiKey: FAKE_API_KEY,
            });

            const started = Date.now();
            let caughtError: unknown;

            try {
                await model.invoke([new HumanMessage("Hello")], { timeout: TIMEOUT_MS });
            } catch (err) {
                caughtError = err;
            } finally {
                restore();
            }

            const elapsed = Date.now() - started;

            expect(caughtError).toBeDefined();
            expect(elapsed).toBeLessThan(TIMEOUT_MS + GRACE_MS);

            const err = caughtError as { name?: string; message?: string };
            const isTimeoutLike =
                err.name === "TimeoutError" ||
                err.name === "AbortError" ||
                (typeof err.message === "string" && /timeout|abort/i.test(err.message));

            expect(isTimeoutLike).toBe(true);
        },
        TIMEOUT_MS + GRACE_MS + 100,
    );
});
