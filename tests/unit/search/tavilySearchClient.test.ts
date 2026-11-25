import { describe, expect, mock, test } from "bun:test";
import { TavilySearchError } from "../../../src/domain/errors/AppError.ts";
import { TavilySearchClient } from "../../../src/infrastructure/search/TavilySearchClient.ts";

function stubFetch(status: number, body: string) {
    return mock(async (_input: string, _init: RequestInit) => new Response(body, { status }));
}

async function searchError(client: TavilySearchClient): Promise<TavilySearchError> {
    const err = await client.search("key", { query: "q" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TavilySearchError);
    return err as TavilySearchError;
}

describe("TavilySearchClient", () => {
    test("posts the query and settings in snake_case with the key as bearer token", async () => {
        const fetchFn = stubFetch(200, JSON.stringify({ results: [] }));
        const client = new TavilySearchClient({ endpoint: "https://example.test", fetchFn });

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
        const client = new TavilySearchClient({ fetchFn: stubFetch(200, JSON.stringify(body)) });

        expect(await client.search("key", { query: "q" })).toEqual(body);
    });

    test("throws the status and the API's reason for a non-OK response", async () => {
        const body = JSON.stringify({ detail: { error: "This request exceeds your plan's set usage limit." } });
        const err = await searchError(new TavilySearchClient({ fetchFn: stubFetch(432, body) }));

        expect(err.status).toBe(432);
        expect(err.body).toBe(body);
        expect(err.message).toBe(
            "Tavily search failed with HTTP 432: This request exceeds your plan's set usage limit.",
        );
    });

    test("keeps the status of a non-OK response whose body is not JSON", async () => {
        const err = await searchError(new TavilySearchClient({ fetchFn: stubFetch(502, "<html>Bad Gateway</html>") }));

        expect(err.status).toBe(502);
        expect(err.message).toBe("Tavily search failed with HTTP 502");
    });

    test("throws without a status for an OK response that is not JSON", async () => {
        const err = await searchError(new TavilySearchClient({ fetchFn: stubFetch(200, "not json") }));

        expect(err.status).toBeNull();
        expect(err.body).toBe("not json");
    });

    test("wraps a request that got no response, keeping the cause", async () => {
        const cause = new TypeError("fetch failed");
        const fetchFn = mock(async (_input: string, _init: RequestInit): Promise<Response> => {
            throw cause;
        });
        const err = await searchError(new TavilySearchClient({ fetchFn }));

        expect(err.status).toBeNull();
        expect(err.cause).toBe(cause);
        expect(err.message).toBe("Tavily search request failed: fetch failed");
    });

    test("reports a timed out request with the timeout", async () => {
        const fetchFn = mock(async (_input: string, _init: RequestInit): Promise<Response> => {
            throw new DOMException("The operation timed out.", "TimeoutError");
        });
        const err = await searchError(new TavilySearchClient({ fetchFn, timeoutMs: 5_000 }));

        expect(err.message).toBe("Tavily search request failed: timed out after 5000 ms");
    });

    test("has a display message that names no provider", async () => {
        const err = await searchError(new TavilySearchClient({ fetchFn: stubFetch(500, "{}") }));

        expect(err.displayMessage).not.toMatch(/tavily/i);
    });
});
