/**
 * Regression test: does ChatGoogle respect the RunnableConfig `timeout` option?
 *
 * ## Finding (@langchain/google@0.1.6 upstream bug)
 *
 * The non-streaming `_generate` code path (used by `.invoke()`) creates the
 * fetch Request **without** the `signal` that `RunnableConfig.timeout` produces:
 *
 *   // base.js ~line 190 — signal is MISSING:
 *   const response = await this.apiClient.fetch(new Request(url, {
 *       method: "POST",
 *       headers: { "Content-Type": "application/json" },
 *       body: JSON.stringify(body),
 *       // ← no signal
 *   }));
 *
 * The streaming path (`_streamResponseChunks`) does include `signal: options.signal`,
 * so streaming invocations are unaffected. Non-streaming invocations hang forever
 * regardless of any configured timeout.
 *
 * These tests document the broken behaviour so that a library upgrade that fixes
 * it will cause the "bug present" test to fail and the "should work" test to pass.
 *
 * ## Proxy design
 *
 * The fetch proxy only intercepts `generateContent` URLs and honours the
 * `signal` from the caller's `init` so that an abort propagates immediately
 * (no lingering hanging promise after the test completes). All other URLs
 * (e.g. LangSmith health checks) pass through to the real fetch.
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
            // This is the critical pass-through: if the caller wired the timeout
            // AbortSignal into the request, we must honour it so the test doesn't
            // hang after the timeout fires.
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
// Generous buffer above the configured timeout — the call should reject well before this.
const GRACE_MS = 300;

describe("ChatGoogle — RunnableConfig.timeout (upstream @langchain/google bug)", () => {
    /**
     * Asserts the broken behaviour: `_generate` (non-streaming path) drops the
     * AbortSignal, so a stalled API call is never cancelled and invoke() hangs.
     *
     * The test runs with a tight wall-clock deadline (TIMEOUT_MS + GRACE_MS).
     * While the bug is present, invoke() never rejects, caughtError stays
     * undefined, and the elapsed time exceeds TIMEOUT_MS — both asserted below.
     *
     * When @langchain/google fixes this, invoke() will reject before the deadline
     * and caughtError will be defined — causing this test to fail and alerting
     * us to update it.
     *
     * @see docs/upstream_bugs/langchain-google-non-streaming-invoke-ignores-timeout.md
     */
    test(
        "BUG: invoke() hangs instead of rejecting when timeout fires on a stalled API call",
        async () => {
            const restore = installHangingFetchProxy();

            const model = new ChatGoogle({
                model: "gemini-2.5-flash",
                apiKey: FAKE_API_KEY,
            });

            const started = Date.now();
            let caughtError: unknown;
            // Race the invoke against a sentinel that resolves after TIMEOUT_MS + GRACE_MS.
            // This ensures the test always completes within the deadline regardless of
            // whether the bug is present (invoke hangs) or fixed (invoke rejects).
            const sentinel = Symbol("timed-out");
            const result = await Promise.race([
                model.invoke([new HumanMessage("Hello")], { timeout: TIMEOUT_MS }).then(
                    () => undefined,
                    (err: unknown) => {
                        caughtError = err;
                    },
                ),
                new Promise<typeof sentinel>((res) => setTimeout(() => res(sentinel), TIMEOUT_MS + GRACE_MS - 50)),
            ]).finally(restore);

            const elapsed = Date.now() - started;
            const hungForever = result === sentinel;

            // BUG: should have thrown — flip these when the upstream fix lands
            expect(hungForever).toBe(true);
            expect(caughtError).toBeUndefined();
            expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS);
        },
        TIMEOUT_MS + GRACE_MS,
    );
});
