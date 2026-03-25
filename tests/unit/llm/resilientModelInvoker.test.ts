import { describe, expect, mock, test } from "bun:test";
import { AIMessageChunk } from "@langchain/core/messages";
import pino from "pino";
import { AttachmentMode } from "../../../src/application/config/AppConfig.ts";
import type { IInvokableModel } from "../../../src/application/ports/IResilientModelInvoker.ts";
import type { IRoundRobinKeyProvider } from "../../../src/application/ports/IRoundRobinKeyProvider.ts";
import { AllFreeKeysExhaustedError, PaidKeyExhaustedError } from "../../../src/domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../../src/domain/message/GeminiApiKey.ts";
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

// ---------------------------------------------------------------------------
// invokeWithPaidKey — lines 46-51
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker.invokeWithPaidKey", () => {
    test("returns result on success", async () => {
        const response = new AIMessageChunk("paid response");
        const model: IInvokableModel = { invoke: mock(async () => response) };
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKey(() => model, undefined, []);

        expect(result.result).toBe(response);
        expect(result.usedFallback).toBe(false);
    });

    test("throws PaidKeyExhaustedError when paid key returns 429", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const model: IInvokableModel = {
            invoke: mock(async () => {
                throw rateLimitErr;
            }),
        };
        const invoker = makeInvoker();

        await expect(invoker.invokeWithPaidKey(() => model, undefined, [])).rejects.toBeInstanceOf(
            PaidKeyExhaustedError,
        );
    });

    test("uses fallback model on 503 and returns usedFallback=true", async () => {
        const fallbackResponse = new AIMessageChunk("fallback response");
        const primaryModel: IInvokableModel = {
            invoke: mock(async () => {
                throw make503Error();
            }),
        };
        const fallbackModel: IInvokableModel = { invoke: mock(async () => fallbackResponse) };
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKey(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(result.result).toBe(fallbackResponse);
        expect(result.usedFallback).toBe(true);
    });

    test("throws PaidKeyExhaustedError when fallback also returns 429 on paid key", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const primaryModel: IInvokableModel = {
            invoke: mock(async () => {
                throw make503Error();
            }),
        };
        const fallbackModel: IInvokableModel = {
            invoke: mock(async () => {
                throw rateLimitErr;
            }),
        };
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
        const primaryModel: IInvokableModel = {
            invoke: mock(async () => {
                throw make503Error();
            }),
        };
        const fallbackModel: IInvokableModel = {
            invoke: mock(async () => {
                throw unexpectedErr;
            }),
        };
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
        const fallbackResponse = new AIMessageChunk("fallback ok");
        const primaryModel: IInvokableModel = {
            invoke: mock(async () => {
                throw make503Error();
            }),
        };
        const fallbackModel: IInvokableModel = { invoke: mock(async () => fallbackResponse) };
        const invoker = makeInvoker();

        const result = await invoker.invokeWithFreeKeys(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(result.result).toBe(fallbackResponse);
        expect(result.usedFallback).toBe(true);
    });

    test("throws AllFreeKeysExhaustedError when all keys return 429", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const model: IInvokableModel = {
            invoke: mock(async () => {
                throw rateLimitErr;
            }),
        };
        const invoker = makeInvoker(makeTwoKeyProvider());

        await expect(invoker.invokeWithFreeKeys(() => model, undefined, [])).rejects.toBeInstanceOf(
            AllFreeKeysExhaustedError,
        );
    });
});
