import { describe, expect, mock, test } from "bun:test";
import { TokenCountError } from "../../../src/domain/errors/AppError.ts";
import { GeminiTokenCounter } from "../../../src/infrastructure/llm/tokenBudget/GeminiTokenCounter.ts";

function stubFetch(status: number, body: string) {
    return mock(async (_input: string, _init: RequestInit) => new Response(body, { status }));
}

const REQUEST = {
    model: "gemini-3.5-flash",
    apiKey: "secret-key",
    request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "be nice" }] },
        tools: [{ functionDeclarations: [] }],
    },
};

describe("GeminiTokenCounter", () => {
    test("posts the full request as generateContentRequest to the model's countTokens endpoint", async () => {
        const fetchFn = stubFetch(200, JSON.stringify({ totalTokens: 42 }));
        const counter = new GeminiTokenCounter({ endpoint: "https://example.test/v1beta", fetchFn });

        await counter.countTokens(REQUEST);

        const [url, init] = fetchFn.mock.calls[0] ?? [];
        expect(url).toBe("https://example.test/v1beta/models/gemini-3.5-flash:countTokens");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret-key");
        expect(JSON.parse(String(init?.body))).toEqual({
            generateContentRequest: { ...REQUEST.request, model: "models/gemini-3.5-flash" },
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    test("returns totalTokens", async () => {
        const counter = new GeminiTokenCounter({ fetchFn: stubFetch(200, JSON.stringify({ totalTokens: 1234 })) });
        expect(await counter.countTokens(REQUEST)).toBe(1234);
    });

    test("counts a response without totalTokens as zero tokens", async () => {
        const counter = new GeminiTokenCounter({ fetchFn: stubFetch(200, "{}") });
        expect(await counter.countTokens(REQUEST)).toBe(0);
    });

    test("throws a TokenCountError carrying the status and body for a non-OK response", async () => {
        const counter = new GeminiTokenCounter({ fetchFn: stubFetch(429, "quota exceeded") });

        const err = await counter.countTokens(REQUEST).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(TokenCountError);
        expect((err as TokenCountError).status).toBe(429);
        expect((err as TokenCountError).body).toBe("quota exceeded");
    });

    test.each([
        ["invalid JSON", "not json"],
        ["a non-object", "7"],
        ["a non-numeric totalTokens", JSON.stringify({ totalTokens: "12" })],
    ])("throws a TokenCountError without status for %s", async (_label, body) => {
        const counter = new GeminiTokenCounter({ fetchFn: stubFetch(200, body) });

        const err = await counter.countTokens(REQUEST).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(TokenCountError);
        expect((err as TokenCountError).status).toBeNull();
    });
});
