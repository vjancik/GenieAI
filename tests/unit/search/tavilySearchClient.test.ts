import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { TavilySearchError } from "../../../src/domain/errors/AppError.ts";
import { TavilySearchClient } from "../../../src/infrastructure/search/TavilySearchClient.ts";

const testLogger = pino({ level: "silent" });

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

function stubFetch(status: number, body: string) {
    return mock(async (_input: string, _init: RequestInit) => new Response(body, { status }));
}

/** A fetch answering each call with the next of `answers`: a response, or an error to reject with. */
function sequenceFetch(...answers: (Response | Error)[]) {
    return mock(async (_input: string, _init: RequestInit): Promise<Response> => {
        const answer = answers.shift() ?? new Response("unexpected fetch call", { status: 418 });
        if (answer instanceof Error) throw answer;
        return answer;
    });
}

/** A client that doesn't retry unless asked to, and never waits between retries. */
function makeClient(fetchFn: FetchFn, options: { maxRetries?: number; timeoutMs?: number; endpoint?: string } = {}) {
    const { maxRetries = 0, ...rest } = options;
    return new TavilySearchClient(testLogger, { ...rest, fetchFn, retry: { maxRetries, initialDelayMs: 0 } });
}

const ok = (body: object = { results: [] }) => new Response(JSON.stringify(body), { status: 200 });

async function searchError(client: TavilySearchClient): Promise<TavilySearchError> {
    const err = await client.search("key", { query: "q" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TavilySearchError);
    return err as TavilySearchError;
}

describe("TavilySearchClient", () => {
    test("posts the query and settings in snake_case with the key as bearer token", async () => {
        const fetchFn = stubFetch(200, JSON.stringify({ results: [] }));
        const client = makeClient(fetchFn, { endpoint: "https://example.test" });

        await client.search("secret-key", {
            query: "news",
            maxResults: 10,
            searchDepth: "advanced",
            chunksPerSource: 3,
            includeAnswer: false,
            includeUsage: true,
        });

        const [url, init] = fetchFn.mock.calls[0] ?? [];
        expect(url).toBe("https://example.test/search");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-key");
        expect(JSON.parse(String(init?.body))).toEqual({
            query: "news",
            max_results: 10,
            search_depth: "advanced",
            chunks_per_source: 3,
            include_answer: false,
            include_usage: true,
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    test("returns the parsed response body", async () => {
        const body = { query: "q", results: [{ url: "https://a.com", title: "A", content: "text" }] };
        const client = makeClient(stubFetch(200, JSON.stringify(body)));

        expect(await client.search("key", { query: "q" })).toEqual(body);
    });

    test("throws the status and the API's reason for a non-OK response", async () => {
        const body = JSON.stringify({ detail: { error: "This request exceeds your plan's set usage limit." } });
        const err = await searchError(makeClient(stubFetch(432, body)));

        expect(err.status).toBe(432);
        expect(err.body).toBe(body);
        expect(err.message).toBe(
            "Tavily search failed with HTTP 432: This request exceeds your plan's set usage limit.",
        );
    });

    test("keeps the status of a non-OK response whose body is not JSON", async () => {
        const err = await searchError(makeClient(stubFetch(502, "<html>Bad Gateway</html>")));

        expect(err.status).toBe(502);
        expect(err.message).toBe("Tavily search failed with HTTP 502");
    });

    test("throws without a status for an OK response that is not JSON", async () => {
        const err = await searchError(makeClient(stubFetch(200, "not json")));

        expect(err.status).toBeNull();
        expect(err.body).toBe("not json");
    });

    test("wraps a request that got no response, keeping the cause", async () => {
        const cause = new TypeError("fetch failed");
        const fetchFn = mock(async (_input: string, _init: RequestInit): Promise<Response> => {
            throw cause;
        });
        const err = await searchError(makeClient(fetchFn));

        expect(err.status).toBeNull();
        expect(err.cause).toBe(cause);
        expect(err.message).toBe("Tavily search request failed: fetch failed");
    });

    test("reports a timed out request with the timeout", async () => {
        const fetchFn = mock(async (_input: string, _init: RequestInit): Promise<Response> => {
            throw new DOMException("The operation timed out.", "TimeoutError");
        });
        const err = await searchError(makeClient(fetchFn, { timeoutMs: 5_000 }));

        expect(err.message).toBe("Tavily search request failed: timed out after 5000 ms");
    });

    describe("retries", () => {
        test.each<[string, Response | Error]>([
            ["HTTP 500", new Response("{}", { status: 500 })],
            ["HTTP 503", new Response("<html>Unavailable</html>", { status: 503 })],
            ["a network failure", new TypeError("fetch failed")],
            ["a timeout", new DOMException("The operation timed out.", "TimeoutError")],
        ])("retries %s once by default", async (_name, failure) => {
            const fetchFn = sequenceFetch(failure, ok({ results: ["retried"] }));
            const client = new TavilySearchClient(testLogger, { fetchFn, retry: { initialDelayMs: 0 } });

            expect(await client.search("key", { query: "q" })).toEqual({ results: ["retried"] });
            expect(fetchFn).toHaveBeenCalledTimes(2);
        });

        test("retries with the same key and body", async () => {
            const fetchFn = sequenceFetch(new Response("{}", { status: 500 }), ok());

            await makeClient(fetchFn, { maxRetries: 1 }).search("secret-key", { query: "q" });

            const [first, second] = fetchFn.mock.calls;
            expect(second?.[1].body).toBe(first?.[1].body);
            expect(new Headers(second?.[1].headers).get("Authorization")).toBe("Bearer secret-key");
        });

        test("retries as often as configured, noting the retries in the final error", async () => {
            const fetchFn = sequenceFetch(
                new Response("{}", { status: 500 }),
                new Response("{}", { status: 502 }),
                new Response("{}", { status: 504 }),
            );

            const err = await searchError(makeClient(fetchFn, { maxRetries: 2 }));

            expect(fetchFn).toHaveBeenCalledTimes(3);
            expect(err.status).toBe(504);
            expect(err.message).toBe("Tavily search failed with HTTP 504 after 2 retries");
        });

        // Key-related failures must surface at once so the caller can rotate keys
        test.each([400, 401, 403, 429, 432, 433])("does not retry HTTP %d", async (status) => {
            const fetchFn = sequenceFetch(new Response("{}", { status }), ok());

            const err = await searchError(makeClient(fetchFn, { maxRetries: 3 }));

            expect(err.status).toBe(status);
            expect(fetchFn).toHaveBeenCalledTimes(1);
        });

        test("does not retry a malformed OK response", async () => {
            const fetchFn = sequenceFetch(new Response("not json", { status: 200 }), ok());

            await searchError(makeClient(fetchFn, { maxRetries: 3 }));

            expect(fetchFn).toHaveBeenCalledTimes(1);
        });
    });

    test("has a display message that names no provider", async () => {
        const err = await searchError(makeClient(stubFetch(500, "{}")));

        expect(err.displayMessage).not.toMatch(/tavily/i);
    });
});
