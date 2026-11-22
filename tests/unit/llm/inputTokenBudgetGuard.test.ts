import { describe, expect, mock, spyOn, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google";
import pino from "pino";
import type { ITokenCounter, TokenCountRequest } from "../../../src/application/ports/ITokenCounter.ts";
import type { GeminiApiKey } from "../../../src/domain/entities/GeminiApiKey.ts";
import {
    extractDisplayMessage,
    getDeclaredRetryable,
    InputTokenBudgetExceededError,
    TokenCountError,
} from "../../../src/domain/errors/AppError.ts";
import { InputTokenBudgetGuard } from "../../../src/infrastructure/llm/tokenBudget/InputTokenBudgetGuard.ts";

const logger = pino({ level: "silent" });
const MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
const BODY = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

function makeKey(id: string): GeminiApiKey {
    return { id, apiKey: `api-key-${id}`, isPaid: false, lastUsed: false };
}

/** Counter stub answering each call with the next result, repeating the last one. */
function makeCounter(...results: Array<number | Error>) {
    let call = 0;
    return {
        countTokens: mock(async (_request: TokenCountRequest) => {
            const result = results[Math.min(call++, results.length - 1)] ?? 0;
            if (result instanceof Error) throw result;
            return result;
        }),
    } satisfies ITokenCounter;
}

/** Fires a `google-request-*` event at `handler`, as `@langchain/google` does before each request. */
function fireRequest(handler: { handleCustomEvent?: (...args: never[]) => unknown }, url = MODEL_URL) {
    const fire = handler.handleCustomEvent as (name: string, data: unknown) => Promise<void>;
    return fire.call(handler, "google-request-GenerateContentApiHandler", { url, headers: {}, body: BODY });
}

describe("InputTokenBudgetGuard", () => {
    test("lets an input within the budget through, counting it with the key and model of the request", async () => {
        const counter = makeCounter(100);
        const handler = new InputTokenBudgetGuard(counter, 100, logger).forRequest().handlerFor(makeKey("k1"));

        await fireRequest(handler);

        expect(counter.countTokens).toHaveBeenCalledWith({
            model: "gemini-3.5-flash",
            apiKey: "api-key-k1",
            request: BODY,
        });
    });

    test("throws a non-retryable, displayable error for an input over the budget", async () => {
        const handler = new InputTokenBudgetGuard(makeCounter(101), 100, logger).forRequest().handlerFor(makeKey("k1"));

        const err = await fireRequest(handler).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(InputTokenBudgetExceededError);
        expect((err as InputTokenBudgetExceededError).inputTokens).toBe(101);
        expect(getDeclaredRetryable(err as InputTokenBudgetExceededError)).toBe(false);
        expect(extractDisplayMessage(err)).toStartWith(
            "The request has surpassed the configured token limit and won't be processed.",
        );
        expect(extractDisplayMessage(err)).not.toContain("101");
    });

    test("ignores other custom events and malformed payloads", async () => {
        const counter = makeCounter(1_000);
        const handler = new InputTokenBudgetGuard(counter, 100, logger).forRequest().handlerFor(makeKey("k1"));
        const fire = handler.handleCustomEvent as (name: string, data: unknown) => Promise<void>;

        await fire.call(handler, "google-response-GenerateContentApiHandler", { url: MODEL_URL, body: BODY });
        await fire.call(handler, "google-request-GenerateContentApiHandler", { url: MODEL_URL });

        expect(counter.countTokens).not.toHaveBeenCalled();
    });

    test("counts once per request across attempts on other keys", async () => {
        const counter = makeCounter(500);
        const check = new InputTokenBudgetGuard(counter, 100, logger).forRequest();

        await expect(fireRequest(check.handlerFor(makeKey("k1")))).rejects.toBeInstanceOf(
            InputTokenBudgetExceededError,
        );
        await expect(fireRequest(check.handlerFor(makeKey("k2")))).rejects.toBeInstanceOf(
            InputTokenBudgetExceededError,
        );

        expect(counter.countTokens).toHaveBeenCalledTimes(1);
    });

    test("shares one in-flight count between concurrent calls", async () => {
        const counter = makeCounter(500);
        const check = new InputTokenBudgetGuard(counter, 100, logger).forRequest();
        const handler = check.handlerFor(makeKey("k1"));

        const results = await Promise.allSettled([fireRequest(handler), fireRequest(handler)]);

        expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
        expect(counter.countTokens).toHaveBeenCalledTimes(1);
    });

    test("counts separately for separate requests", async () => {
        const counter = makeCounter(50);
        const guard = new InputTokenBudgetGuard(counter, 100, logger);

        await fireRequest(guard.forRequest().handlerFor(makeKey("k1")));
        await fireRequest(guard.forRequest().handlerFor(makeKey("k1")));

        expect(counter.countTokens).toHaveBeenCalledTimes(2);
    });

    test("fails open when counting fails, then counts again on the next attempt", async () => {
        const counter = makeCounter(new TokenCountError("rate limited", 429, ""), 500);
        const check = new InputTokenBudgetGuard(counter, 100, logger).forRequest();

        await fireRequest(check.handlerFor(makeKey("k1")));
        await expect(fireRequest(check.handlerFor(makeKey("k2")))).rejects.toBeInstanceOf(
            InputTokenBudgetExceededError,
        );

        expect(counter.countTokens).toHaveBeenCalledTimes(2);
        expect(counter.countTokens.mock.calls[1]?.[0].apiKey).toBe("api-key-k2");
    });

    test("fails open without counting when the request URL names no model", async () => {
        const counter = makeCounter(1_000);
        const handler = new InputTokenBudgetGuard(counter, 100, logger).forRequest().handlerFor(makeKey("k1"));

        await fireRequest(handler, "https://example.test/unknown");

        expect(counter.countTokens).not.toHaveBeenCalled();
    });
});

/**
 * Exercises the guard through a real `ChatGoogle`, pinning the `@langchain/google` behavior it relies
 * on: the `google-request-*` event carries the exact request body and fires before the request is
 * sent, and a handler error aborts the call.
 */
describe("InputTokenBudgetGuard with ChatGoogle", () => {
    const GEMINI_RESPONSE = {
        candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };

    function createModel() {
        return new ChatGoogle({ model: "gemini-3.5-flash", apiKey: "test-api-key", maxRetries: 0 });
    }

    test("aborts the call before it is sent when the input exceeds the budget", async () => {
        const fetchSpy = spyOn(globalThis, "fetch");
        try {
            const handler = new InputTokenBudgetGuard(makeCounter(1_000), 100, logger)
                .forRequest()
                .handlerFor(makeKey("k1"));

            const err = await createModel()
                .invoke([new HumanMessage("hi")], { callbacks: [handler] })
                .catch((e: unknown) => e);

            expect(err).toBeInstanceOf(InputTokenBudgetExceededError);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    test("counts the exact request body and lets an input within the budget through", async () => {
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
            // TYPE COERCION: the stub omits Bun's `fetch.preconnect`, which the model never calls
            (async () => new Response(JSON.stringify(GEMINI_RESPONSE), { status: 200 })) as unknown as typeof fetch,
        );
        try {
            const counter = makeCounter(10);
            const handler = new InputTokenBudgetGuard(counter, 100, logger).forRequest().handlerFor(makeKey("k1"));

            const result = await createModel().invoke([new HumanMessage("hi")], { callbacks: [handler] });

            expect(result.text).toBe("hello");
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const sentRequest = fetchSpy.mock.calls[0]?.[0];
            const sentBody = sentRequest instanceof Request ? await sentRequest.clone().json() : null;
            const counted = counter.countTokens.mock.calls[0]?.[0];
            expect(counted?.model).toBe("gemini-3.5-flash");
            expect(counted?.request).toEqual(sentBody);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
