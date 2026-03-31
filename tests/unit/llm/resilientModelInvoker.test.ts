import { describe, expect, mock, test } from "bun:test";
import { AIMessageChunk } from "@langchain/core/messages";
import pino from "pino";
import { AttachmentMode } from "../../../src/application/config/AppConfig.ts";
import type { IInvokableModel } from "../../../src/application/ports/IResilientModelInvoker.ts";
import type { IRoundRobinKeyProvider } from "../../../src/application/ports/IRoundRobinKeyProvider.ts";
import type { GeminiApiKey } from "../../../src/domain/entities/GeminiApiKey.ts";
import { AllFreeKeysExhaustedError, PaidKeyExhaustedError } from "../../../src/domain/errors/AppError.ts";
import { ResilientModelInvoker } from "../../../src/infrastructure/llm/ResilientModelInvoker.ts";

const logger = pino({ level: "silent" });

function makeKey(id: string): GeminiApiKey {
    return { id, apiKey: `key-${id}` } as GeminiApiKey;
}

/** Single-key provider stub. */
function makeSingleKeyProvider(id = "k1"): IRoundRobinKeyProvider {
    const key = makeKey(id);
    return {
        get currentKey() {
            return key;
        },
        nextKey: mock(() => key),
        keyCount: 1,
    };
}

/** Two-key round-robin provider stub. */
function makeTwoKeyProvider(): IRoundRobinKeyProvider & { advanceCount: number } {
    const k1 = makeKey("k1");
    const k2 = makeKey("k2");
    const keys: [GeminiApiKey, GeminiApiKey] = [k1, k2];
    let cursor = 0;
    const provider = {
        get currentKey() {
            return keys[cursor] ?? k1;
        },
        nextKey: mock(() => {
            cursor = (cursor + 1) % keys.length;
            provider.advanceCount++;
            return keys[cursor] ?? k1;
        }),
        keyCount: 2,
        advanceCount: 0,
    };
    return provider;
}

function makeInvoker(freeProvider = makeSingleKeyProvider(), paidProvider = makeSingleKeyProvider("paid")) {
    return new ResilientModelInvoker(
        freeProvider,
        paidProvider,
        AttachmentMode.inline,
        100 * 1024 * 1024,
        60_000,
        logger,
    );
}

function make503Error() {
    return Object.assign(new Error("Service Unavailable"), { status: 503 });
}

/** Model stub that yields a single chunk from stream(). */
function makeSuccessModel(chunk: AIMessageChunk): IInvokableModel {
    return {
        invoke: mock(async () => chunk),
        stream: mock(async () =>
            (async function* () {
                yield chunk;
            })(),
        ),
    };
}

/** Model stub whose stream() throws the given error. */
function makeErrorModel(err: unknown): IInvokableModel {
    return {
        invoke: mock(async () => {
            throw err;
        }),
        // TYPE COERCION: async function that always throws satisfies AsyncIterable<AIMessageChunk>
        stream: mock(
            async () =>
                ({
                    [Symbol.asyncIterator]() {
                        return {
                            next: async () => {
                                throw err;
                            },
                        };
                    },
                }) as AsyncIterable<AIMessageChunk>,
        ),
    };
}

// ---------------------------------------------------------------------------
// invokeWithPaidKey — lines 46-51
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker.invokeWithPaidKey", () => {
    test("returns result on success", async () => {
        const model = makeSuccessModel(new AIMessageChunk("paid response"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKey(() => model, undefined, []);

        expect(result.result.content).toBe("paid response");
        expect(result.usedFallback).toBe(false);
    });

    test("throws PaidKeyExhaustedError when paid key returns 429", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const model = makeErrorModel(rateLimitErr);
        const invoker = makeInvoker();

        await expect(invoker.invokeWithPaidKey(() => model, undefined, [])).rejects.toBeInstanceOf(
            PaidKeyExhaustedError,
        );
    });

    test("uses fallback model on 503 and returns usedFallback=true", async () => {
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeSuccessModel(new AIMessageChunk("fallback response"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKey(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(result.result.content).toBe("fallback response");
        expect(result.usedFallback).toBe(true);
    });

    test("throws PaidKeyExhaustedError when fallback also returns 429 on paid key", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeErrorModel(rateLimitErr);
        const invoker = makeInvoker();

        await expect(
            invoker.invokeWithPaidKey(
                () => primaryModel,
                () => fallbackModel,
                [],
            ),
        ).rejects.toBeInstanceOf(PaidKeyExhaustedError);
    });

    test("propagates non-429 fallback errors immediately", async () => {
        const unexpectedErr = new Error("unexpected network failure");
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeErrorModel(unexpectedErr);
        const invoker = makeInvoker();

        await expect(
            invoker.invokeWithPaidKey(
                () => primaryModel,
                () => fallbackModel,
                [],
            ),
        ).rejects.toBe(unexpectedErr);
    });
});

// ---------------------------------------------------------------------------
// invokeWithFreeKeys — fallback model path (complementary coverage)
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker.invokeWithFreeKeys — fallback model", () => {
    test("uses fallback model on 503 and returns usedFallback=true", async () => {
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeSuccessModel(new AIMessageChunk("fallback ok"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithFreeKeys(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(result.result.content).toBe("fallback ok");
        expect(result.usedFallback).toBe(true);
    });

    test("throws AllFreeKeysExhaustedError when all keys return 429", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const model = makeErrorModel(rateLimitErr);
        const invoker = makeInvoker(makeTwoKeyProvider());

        await expect(invoker.invokeWithFreeKeys(() => model, undefined, [])).rejects.toBeInstanceOf(
            AllFreeKeysExhaustedError,
        );
    });
});
