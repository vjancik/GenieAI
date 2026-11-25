import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { toTavilyApiKeys } from "../../../src/domain/entities/TavilyApiKey.ts";
import { AllSearchKeysExhaustedError, TavilySearchError } from "../../../src/domain/errors/AppError.ts";
import { RoundRobinKeyProvider } from "../../../src/infrastructure/llm/RoundRobinKeyProvider.ts";
import { KeyRotatingTavilySearch } from "../../../src/infrastructure/search/KeyRotatingTavilySearch.ts";
import type { TavilySearchRequest } from "../../../src/infrastructure/search/TavilySearchClient.ts";

const testLogger = pino({ level: "silent" });

const httpError = (status: number) => new TavilySearchError(`HTTP ${status}`, status, "{}");

/** How the client answers a key: an HTTP status to fail with, or a body to resolve to. */
type Outcome = number | object;

/** Builds a search over one key per entry of `outcomes`, whose client answers each key with its outcome. */
function makeSearch(outcomes: Record<string, Outcome>) {
    const search = mock(async (apiKey: string, _request: TavilySearchRequest) => {
        const outcome = outcomes[apiKey];
        if (typeof outcome === "number") throw httpError(outcome);
        return outcome;
    });
    const keyProvider = new RoundRobinKeyProvider(toTavilyApiKeys(Object.keys(outcomes)));
    const rotating = new KeyRotatingTavilySearch({ search }, keyProvider, { maxResults: 5 }, testLogger);
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

    // Transient failures arrive here only once the client's own retries are used up
    test.each([400, 500, 503])("throws HTTP %d without rotating", async (status) => {
        const { rotating, search, keyProvider } = makeSearch({ first: status, second: { results: [] } });

        await expect(rotating.search("news")).rejects.toMatchObject({ status });
        expect(requestedKeys(search)).toEqual(["first"]);
        expect(keyProvider.currentKey.apiKey).toBe("first");
    });
});
