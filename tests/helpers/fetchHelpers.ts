/**
 * Shared fetch mocking helpers for unit tests.
 *
 * These utilities cover the common cases of mocking simple HTTP responses
 * (text/HTML pages, HEAD requests for content-type detection). Tests that
 * need binary body capture or protocol-level inspection (e.g. resumable
 * uploads) keep their own specialised mocks.
 */

import { spyOn } from "bun:test";

export type SimpleMockResponseOpts = {
    ok?: boolean;
    status?: number;
    body?: string;
    contentType?: string;
};

/**
 * Recognizes fetch calls made by infrastructure we mount globally but don't
 * want tests to care about — chiefly LangChain's LangSmith tracing client,
 * which lazily probes its `/info` endpoint through the global `fetch` the
 * first time a trace runs (e.g. during `tool.invoke()`).
 *
 * When the global `fetch` is mocked, that probe would otherwise (a) crash on
 * `res.json()` if the mock lacks it, or (b) inflate call counts so assertions
 * like `toHaveBeenCalledTimes(1)` fail non-deterministically depending on
 * whether tracing is enabled and on concurrent test-file scheduling. We detect
 * these calls and answer them with a benign response, separate from the
 * responses the code under test expects.
 */
function isInfraProbe(url: string): boolean {
    return url.includes("smith.langchain.com") || url.includes("/info");
}

/**
 * A benign JSON response for infra probes (see {@link isInfraProbe}). Satisfies
 * the LangSmith client's `res.ok` / `res.json()` access without affecting the
 * response the code under test receives.
 */
function infraProbeResponse(): object {
    return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => "{}",
        json: async () => ({}),
    };
}

/**
 * Builds a minimal Response-like object suitable for text/HTML fetch mocks.
 * Headers support only `content-type` lookup.
 *
 * Note on `json()`: LangChain's LangSmith tracing client lazily probes its
 * `/info` endpoint through the global `fetch` the first time a trace runs
 * (e.g. during `tool.invoke()`). Because tests replace the global `fetch`
 * with this mock, that probe can land here and call `.json()`. Providing a
 * `json()` stub keeps the probe from throwing `res.json is not a function`,
 * which previously failed fetch-mocking tests non-deterministically depending
 * on concurrent test-file scheduling.
 */
export function makeMockResponse(opts: SimpleMockResponseOpts = {}): object {
    const body = opts.body ?? "<html><body><h1>Hello</h1><p>World</p></body></html>";
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        headers: { get: (key: string) => (key === "content-type" ? (opts.contentType ?? "text/html") : null) },
        text: async () => body,
        // Stub so a stray LangSmith `/info` probe through the mocked fetch
        // cannot crash with "res.json is not a function" (see note above).
        json: async () => ({}),
    };
}

/**
 * Builds a minimal Response for HEAD-style requests (content-type detection).
 * Uses the real `Response` constructor so callers can check `response.headers`.
 */
export function makeHeadResponse(contentType: string | null, ok = true): Response {
    return new Response(null, {
        status: ok ? 200 : 404,
        headers: contentType ? { "content-type": contentType } : {},
    });
}

/** Extracts a URL string from the various shapes `fetch`'s first arg can take. */
function urlOf(input: unknown): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    return String(input);
}

/**
 * Installs a `spyOn` fetch mock backed by a factory function.
 *
 * Calls to infrastructure probe endpoints (see {@link isInfraProbe} — e.g.
 * LangSmith's `/info`) are transparently answered with a benign response and
 * are NOT passed to `factory`, so the factory only ever sees the URLs the code
 * under test actually requests.
 *
 * The returned spy's call records include infra probes (it spies on the raw
 * `globalThis.fetch`), so prefer asserting against the `factory` having been
 * reached, or restrict `toHaveBeenCalledTimes` assertions to suites where
 * tracing is disabled. For robust call-count assertions independent of tracing,
 * use {@link spyFetchTooling}.
 *
 * Useful when the response needs to vary per call (e.g. URL-dependent content).
 */
export function spyFetchWith(factory: (url: string, init?: RequestInit) => object) {
    // TYPE COERCION: same as spyFetch — omits browser-only `preconnect`.
    return spyOn(globalThis, "fetch").mockImplementation(
        // TYPE COERCION: factory return is cast to Response; test doubles need
        // only satisfy the fields actually used by the code under test.
        ((input: unknown, init?: RequestInit) => {
            const url = urlOf(input);
            if (isInfraProbe(url)) return Promise.resolve(infraProbeResponse() as Response);
            return Promise.resolve(factory(url, init) as Response);
        }) as typeof fetch,
    );
}

/**
 * Installs a `spyOn` fetch mock that returns the same `response` for every
 * call the code under test makes. Infra probes (see {@link spyFetchWith}) are
 * answered separately and never receive `response`.
 *
 * Returns the spy so callers can assert call counts / args. The spy is
 * automatically restored when `mockRestore()` is called (or via `afterEach`
 * if managed by the caller).
 */
export function spyFetch(response: object) {
    return spyFetchWith(() => response);
}

/**
 * Installs a fetch mock and returns a `{ restore, toolCalls, spy }` handle
 * whose `toolCalls()` reports ONLY the calls made by the code under test —
 * infra probes (see {@link isInfraProbe}) are excluded. Use this when an
 * assertion needs an exact call count that must hold whether or not LangSmith
 * tracing is active in the environment.
 *
 * `factory` receives only non-probe URLs.
 */
export function spyFetchTooling(factory: (url: string, init?: RequestInit) => object) {
    const toolUrls: string[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation(
        // TYPE COERCION: test double; only the fields used by the SUT matter.
        ((input: unknown, init?: RequestInit) => {
            const url = urlOf(input);
            if (isInfraProbe(url)) return Promise.resolve(infraProbeResponse() as Response);
            toolUrls.push(url);
            return Promise.resolve(factory(url, init) as Response);
        }) as typeof fetch,
    );
    return {
        spy,
        /** Number of fetches made by the code under test (excludes infra probes). */
        toolCalls: () => toolUrls.length,
        /** URLs requested by the code under test, in order (excludes infra probes). */
        toolUrls: () => [...toolUrls],
        restore: () => spy.mockRestore(),
    };
}
