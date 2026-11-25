import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { toTavilyApiKeys } from "../../../src/domain/entities/TavilyApiKey.ts";
import { AllSearchKeysExhaustedError, TavilySearchError } from "../../../src/domain/errors/AppError.ts";
import { RoundRobinKeyProvider } from "../../../src/infrastructure/llm/RoundRobinKeyProvider.ts";
import { KeyRotatingTavilySearch } from "../../../src/infrastructure/search/KeyRotatingTavilySearch.ts";
import type { TavilySearchRequest } from "../../../src/infrastructure/search/TavilySearchClient.ts";

const testLogger = pino({ level: "silent" });

const httpError = (status: number) => new TavilySearchError(`HTTP ${status}`, status, "{}");

/** A request that got no response, as the client reports a network failure or timeout. */
const NO_RESPONSE = "no-response";

/** How the client answers one request: an HTTP status to fail with, no response, or a body to resolve to. */
type Outcome = number | typeof NO_RESPONSE | object;

/**
 * Builds a search over one key per entry of `outcomes`, whose client answers each request with
 * the key's next outcome, repeating the last one once they run out. Retries don't wait.
 */
function makeSearch(outcomes: Record<string, Outcome | Outcome[]>, maxRetries?: number) {
    const sequences = new Map(Object.entries(outcomes).map(([key, outcome]) => [key, [outcome].flat()]));
    const search = mock(async (apiKey: string, _request: TavilySearchRequest) => {
        const sequence = sequences.get(apiKey) ?? [];
        const outcome = sequence.length > 1 ? sequence.shift() : sequence[0];
        if (typeof outcome === "number") throw httpError(outcome);
        if (outcome === NO_RESPONSE) throw new TavilySearchError("timed out", null, null);
        return outcome;
    });
    const keyProvider = new RoundRobinKeyProvider(toTavilyApiKeys(Object.keys(outcomes)));
    const rotating = new KeyRotatingTavilySearch({ search }, keyProvider, { maxResults: 5 }, testLogger, {
        maxRetries,
        initialDelayMs: 0,
    });
    return { rotating, search, keyProvider };
}

const requestedKeys = (search: ReturnType<typeof makeSearch>["search"]) => search.mock.calls.map(([apiKey]) => apiKey);

describe("KeyRotatingTavilySearch", () => {
    test("searches with the current key and the configured settings", async () => {
        const body = { results: [] };
        const { rotating, search } = makeSearch({ first: body, second: body });

        expect(await rotating.search("news")).toBe(body);
        expect(search.mock.calls).toEqual([["first", { maxResults: 5, query: "news" }]]);
    });

    test.each([401, 403, 429, 432, 433])("rotates to the next key on HTTP %d", async (status) => {
        const body = { results: [] };
        const { rotating, search, keyProvider } = makeSearch({ first: status, second: body });

        expect(await rotating.search("news")).toBe(body);
        expect(requestedKeys(search)).toEqual(["first", "second"]);
        // Later searches start from the key that worked
        expect(keyProvider.currentKey.apiKey).toBe("second");
    });

    test("throws AllSearchKeysExhaustedError with the last key's error when every key is unusable", async () => {
        const { rotating } = makeSearch({ first: 432, second: 433 });

        const err = await rotating.search("news").catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AllSearchKeysExhaustedError);
        expect((err as AllSearchKeysExhaustedError).cause).toMatchObject({ status: 433 });
        expect((err as AllSearchKeysExhaustedError).displayMessage).toBe(
            "All search provider API keys are currently exhausted, please try again later.",
        );
    });

    test("throws HTTP 400 immediately, without retrying or rotating", async () => {
        const { rotating, search } = makeSearch({ first: 400, second: { results: [] } });

        await expect(rotating.search("news")).rejects.toMatchObject({ status: 400 });
        expect(search).toHaveBeenCalledTimes(1);
    });

    test("does not retry a malformed OK response", async () => {
        const malformed = new TavilySearchError("not JSON", null, "not json");
        const search = mock(async (_apiKey: string, _request: TavilySearchRequest): Promise<unknown> => {
            throw malformed;
        });
        const keyProvider = new RoundRobinKeyProvider(toTavilyApiKeys(["first"]));
        const rotating = new KeyRotatingTavilySearch({ search }, keyProvider, {}, testLogger, { initialDelayMs: 0 });

        await expect(rotating.search("news")).rejects.toBe(malformed);
        expect(search).toHaveBeenCalledTimes(1);
    });

    test.each<[string, Outcome]>([
        ["HTTP 500", 500],
        ["HTTP 503", 503],
        ["no response", NO_RESPONSE],
    ])("retries %s once on the same key by default", async (_name, failure) => {
        const body = { results: [] };
        const { rotating, search } = makeSearch({ first: [failure, body], second: body });

        expect(await rotating.search("news")).toBe(body);
        expect(requestedKeys(search)).toEqual(["first", "first"]);
    });

    test("throws a persisting transient failure after the retries, without rotating", async () => {
        const { rotating, search, keyProvider } = makeSearch({ first: 500, second: { results: [] } });

        await expect(rotating.search("news")).rejects.toMatchObject({ status: 500 });
        expect(requestedKeys(search)).toEqual(["first", "first"]);
        expect(keyProvider.currentKey.apiKey).toBe("first");
    });

    test("retries as often as configured", async () => {
        const body = { results: [] };
        const { rotating, search } = makeSearch({ first: [500, 502, 504, body] }, 3);

        expect(await rotating.search("news")).toBe(body);
        expect(search).toHaveBeenCalledTimes(4);
    });

    test("rotates when a retry reveals the key is unusable", async () => {
        const body = { results: [] };
        const { rotating, search } = makeSearch({ first: [500, 432], second: body });

        expect(await rotating.search("news")).toBe(body);
        expect(requestedKeys(search)).toEqual(["first", "first", "second"]);
    });
});
