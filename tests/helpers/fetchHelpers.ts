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
 * Builds a minimal Response-like object suitable for text/HTML fetch mocks.
 * Headers support only `content-type` lookup.
 */
export function makeMockResponse(opts: SimpleMockResponseOpts = {}): object {
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        headers: { get: (key: string) => (key === "content-type" ? (opts.contentType ?? "text/html") : null) },
        text: async () => opts.body ?? "<html><body><h1>Hello</h1><p>World</p></body></html>",
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

/**
 * Installs a `spyOn` fetch mock that returns the same response for every call.
 * Returns the spy so callers can assert call counts / args.
 *
 * The spy is automatically restored when `mockRestore()` is called (or via
 * `afterEach` if managed by the caller).
 */
export function spyFetch(response: object) {
    // TYPE COERCION: test doubles intentionally omit the `preconnect` property
    // that Bun's fetch type includes (only relevant in browser contexts).
    return spyOn(globalThis, "fetch").mockResolvedValue(response as Response);
}

/**
 * Installs a `spyOn` fetch mock backed by a factory function.
 * Useful when the response needs to vary per call (e.g. URL-dependent content).
 */
export function spyFetchWith(factory: (url: string, init?: RequestInit) => object) {
    // TYPE COERCION: same as spyFetch — omits browser-only `preconnect`.
    return spyOn(globalThis, "fetch").mockImplementation(
        // TYPE COERCION: factory return is cast to Response; test doubles need
        // only satisfy the fields actually used by the code under test.
        ((url: string, init?: RequestInit) => Promise.resolve(factory(url, init))) as typeof fetch,
    );
}
