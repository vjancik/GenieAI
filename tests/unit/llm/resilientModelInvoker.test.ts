import { describe, expect, mock, test } from "bun:test";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { sleep } from "bun";
import pino from "pino";
import { AttachmentMode, FallbackExecutionMode } from "../../../src/application/config/AppConfig.ts";
import { extractContent } from "../../../src/application/helpers/langchainMessageTransformers.ts";
import type { IInvokableModel } from "../../../src/application/ports/IResilientModelInvoker.ts";
import type { IRoundRobinKeyProvider } from "../../../src/application/ports/IRoundRobinKeyProvider.ts";
import type { GeminiApiKey } from "../../../src/domain/entities/GeminiApiKey.ts";
import {
    AllFreeKeysExhaustedError,
    AllPaidKeysExhaustedError,
    ModelNoCandidatesError,
    ModelOverloadedError,
    ModelPromptBlockedError,
    ModelTimeoutError,
} from "../../../src/domain/errors/AppError.ts";
import { FinishReason } from "../../../src/domain/value-objects/FinishReason.ts";
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

function makeInvoker(
    freeProvider = makeSingleKeyProvider(),
    paidProvider = makeSingleKeyProvider("paid"),
    fallbackExecutionMode: FallbackExecutionMode = FallbackExecutionMode.sequential,
) {
    return new ResilientModelInvoker(
        freeProvider,
        paidProvider,
        {
            attachmentMode: AttachmentMode.inline,
            maxInlineBytes: 100 * 1024 * 1024,
            globalTimeoutMs: 60_000,
            fallbackExecutionMode,
        },
        logger,
    );
}

/** Mirrors the `@langchain/google` RequestError Gemini returns when the model is under high demand. */
function make503Error() {
    return Object.assign(new Error("This model is currently experiencing high demand."), {
        name: "RequestError",
        statusCode: 503,
        statusText: "Service Unavailable",
        data: { error: { code: 503, status: "UNAVAILABLE" } },
    });
}

/** Mirrors the `@langchain/google` RequestError for a response with the given HTTP status. */
function makeKeyRejectedError(statusCode: number) {
    return Object.assign(new Error("The caller does not have permission"), {
        name: "RequestError",
        statusCode,
        data: { error: { code: statusCode } },
    });
}

function makeTimeoutError() {
    return new DOMException("The operation timed out.", "TimeoutError");
}

/** Model stub that returns the given message from invoke() (and yields it as a single chunk from stream()). */
function makeSuccessModel(message: AIMessageChunk | AIMessage): IInvokableModel {
    const chunk = AIMessageChunk.isInstance(message) ? message : new AIMessageChunk(message.lc_kwargs);
    return {
        invoke: mock(async () => message),
        stream: mock(async () =>
            (async function* () {
                yield chunk;
            })(),
        ),
    };
}

/** Model stub whose invoke() and stream() throw the given error. */
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
// invokeWithPaidKeys — lines 46-51
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker.invokeWithPaidKeys", () => {
    test("returns result on success", async () => {
        const model = makeSuccessModel(new AIMessageChunk("paid response"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(extractContent(result.result.content)).toBe("paid response");
        expect(result.usedFallback).toBe(false);
    });

    test("throws AllPaidKeysExhaustedError when the only paid key returns 429", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const model = makeErrorModel(rateLimitErr);
        const invoker = makeInvoker();

        await expect(invoker.invokeWithPaidKeys(() => model, undefined, [])).rejects.toBeInstanceOf(
            AllPaidKeysExhaustedError,
        );
    });

    test("rotates to the next paid key on 429", async () => {
        const provider = makeTwoKeyProvider();
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const models: Record<string, IInvokableModel> = {
            k1: makeErrorModel(rateLimitErr),
            k2: makeSuccessModel(new AIMessageChunk("second paid key")),
        };
        const invoker = makeInvoker(makeSingleKeyProvider(), provider);

        const result = await invoker.invokeWithPaidKeys((key) => models[key.id] as IInvokableModel, undefined, []);

        expect(extractContent(result.result.content)).toBe("second paid key");
        expect(provider.advanceCount).toBe(1);
    });

    test("throws AllPaidKeysExhaustedError with the last error as cause when every paid key is unusable", async () => {
        const provider = makeTwoKeyProvider();
        const lastErr = makeKeyRejectedError(403);
        const models: Record<string, IInvokableModel> = {
            k1: makeErrorModel(Object.assign(new Error("Too Many Requests"), { status: 429 })),
            k2: makeErrorModel(lastErr),
        };
        const invoker = makeInvoker(makeSingleKeyProvider(), provider);

        const thrown = await invoker
            .invokeWithPaidKeys((key) => models[key.id] as IInvokableModel, undefined, [])
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(AllPaidKeysExhaustedError);
        expect((thrown as AllPaidKeysExhaustedError).cause).toBe(lastErr);
        expect(models.k1?.invoke).toHaveBeenCalledTimes(1);
        expect(models.k2?.invoke).toHaveBeenCalledTimes(1);
    });

    test("uses fallback model on 503 and returns usedFallback=true", async () => {
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeSuccessModel(new AIMessageChunk("fallback response"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKeys(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(extractContent(result.result.content)).toBe("fallback response");
        expect(result.usedFallback).toBe(true);
    });

    test("throws AllPaidKeysExhaustedError when fallback also returns 429 on paid key", async () => {
        const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeErrorModel(rateLimitErr);
        const invoker = makeInvoker();

        await expect(
            invoker.invokeWithPaidKeys(
                () => primaryModel,
                () => fallbackModel,
                [],
            ),
        ).rejects.toBeInstanceOf(AllPaidKeysExhaustedError);
    });

    test("propagates non-429 fallback errors immediately", async () => {
        const unexpectedErr = new Error("unexpected network failure");
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeErrorModel(unexpectedErr);
        const invoker = makeInvoker();

        await expect(
            invoker.invokeWithPaidKeys(
                () => primaryModel,
                () => fallbackModel,
                [],
            ),
        ).rejects.toBe(unexpectedErr);
    });
});

// ---------------------------------------------------------------------------
// Key rejection (401, 402, 403) — rotates like a rate limit
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker — rejected key rotation", () => {
    test.each([401, 402, 403])("rotates to the next paid key when the main model returns %d", async (status) => {
        const provider = makeTwoKeyProvider();
        const models: Record<string, IInvokableModel> = {
            k1: makeErrorModel(makeKeyRejectedError(status)),
            k2: makeSuccessModel(new AIMessageChunk("second key")),
        };
        const invoker = makeInvoker(makeSingleKeyProvider(), provider);

        const result = await invoker.invokeWithPaidKeys((key) => models[key.id] as IInvokableModel, undefined, []);

        expect(extractContent(result.result.content)).toBe("second key");
        expect(provider.advanceCount).toBe(1);
    });

    test("rotates free keys on a rejected key as well", async () => {
        const provider = makeTwoKeyProvider();
        const models: Record<string, IInvokableModel> = {
            k1: makeErrorModel(makeKeyRejectedError(401)),
            k2: makeSuccessModel(new AIMessageChunk("second key")),
        };

        const result = await makeInvoker(provider).invokeWithFreeKeys(
            (key) => models[key.id] as IInvokableModel,
            undefined,
            [],
        );

        expect(extractContent(result.result.content)).toBe("second key");
        expect(provider.advanceCount).toBe(1);
    });

    test("does not try the fallback model on a rejected key, since it shares the key", async () => {
        const provider = makeTwoKeyProvider();
        const fallback = makeSuccessModel(new AIMessageChunk("fallback"));
        const models: Record<string, IInvokableModel> = {
            k1: makeErrorModel(makeKeyRejectedError(403)),
            k2: makeSuccessModel(new AIMessageChunk("second key")),
        };
        const invoker = makeInvoker(makeSingleKeyProvider(), provider);

        const result = await invoker.invokeWithPaidKeys(
            (key) => models[key.id] as IInvokableModel,
            () => fallback,
            [],
        );

        expect(extractContent(result.result.content)).toBe("second key");
        expect(result.usedFallback).toBe(false);
        expect(fallback.invoke).not.toHaveBeenCalled();
    });

    test("rotates when the fallback model is the one rejected", async () => {
        const provider = makeTwoKeyProvider();
        const mains: Record<string, IInvokableModel> = {
            k1: makeErrorModel(make503Error()),
            k2: makeSuccessModel(new AIMessageChunk("second key")),
        };
        const invoker = makeInvoker(makeSingleKeyProvider(), provider);

        const result = await invoker.invokeWithPaidKeys(
            (key) => mains[key.id] as IInvokableModel,
            () => makeErrorModel(makeKeyRejectedError(402)),
            [],
        );

        expect(extractContent(result.result.content)).toBe("second key");
        expect(provider.advanceCount).toBe(1);
    });

    test("rotates when attachment preparation is rejected with a Files API error", async () => {
        const provider = makeTwoKeyProvider();
        const model = makeSuccessModel(new AIMessageChunk("answer"));
        // Mirrors the `@google/genai` ApiError, which carries the HTTP status as `status`
        const apiError = Object.assign(new Error('{"error":{"code":403}}'), { name: "ApiError", status: 403 });
        const normalize = mock(async (messages: BaseMessage[], apiKeyId: string) => {
            if (apiKeyId === "k1") throw apiError;
            return messages;
        });
        const invoker = new ResilientModelInvoker(
            makeSingleKeyProvider(),
            provider,
            {
                attachmentMode: AttachmentMode.upload,
                maxInlineBytes: 100 * 1024 * 1024,
                globalTimeoutMs: 60_000,
                fallbackExecutionMode: FallbackExecutionMode.sequential,
            },
            logger,
            { normalize },
        );

        const result = await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(extractContent(result.result.content)).toBe("answer");
        expect(normalize).toHaveBeenCalledTimes(2);
        expect(model.invoke).toHaveBeenCalledTimes(1);
        expect(provider.advanceCount).toBe(1);
    });

    test("does not rotate on other client errors", async () => {
        const provider = makeTwoKeyProvider();
        const badRequest = makeKeyRejectedError(400);
        const invoker = makeInvoker(makeSingleKeyProvider(), provider);

        await expect(invoker.invokeWithPaidKeys(() => makeErrorModel(badRequest), undefined, [])).rejects.toBe(
            badRequest,
        );
        expect(provider.advanceCount).toBe(0);
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

        expect(extractContent(result.result.content)).toBe("fallback ok");
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

// ---------------------------------------------------------------------------
// Non-streaming invocation — response normalization and timeout forwarding
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker — non-streaming invocation", () => {
    test("calls invoke() rather than stream()", async () => {
        const model = makeSuccessModel(new AIMessageChunk("answer"));
        const invoker = makeInvoker();

        await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(model.invoke).toHaveBeenCalledTimes(1);
        expect(model.stream).not.toHaveBeenCalled();
    });

    test("passes a plain AIMessage response through unchanged", async () => {
        const message = new AIMessage({ content: "answer", response_metadata: { finishReason: "STOP" } });
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKeys(() => makeSuccessModel(message), undefined, []);

        expect(result.result).toBe(message);
        expect(result.finishReason).toBe(FinishReason.STOP);
    });

    test("normalizes an AIMessageChunk response to a plain AIMessage", async () => {
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKeys(
            () => makeSuccessModel(new AIMessageChunk("answer")),
            undefined,
            [],
        );

        expect(AIMessageChunk.isInstance(result.result)).toBe(false);
        expect(AIMessage.isInstance(result.result)).toBe(true);
        expect(extractContent(result.result.content)).toBe("answer");
    });

    test("forwards the per-call timeout, falling back to the global timeout", async () => {
        const model = makeSuccessModel(new AIMessageChunk("answer"));
        const invoker = makeInvoker();

        await invoker.invokeWithPaidKeys(() => model, undefined, [], { timeoutMs: 5_000 });
        await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(model.invoke).toHaveBeenNthCalledWith(1, [], { timeout: 5_000 });
        expect(model.invoke).toHaveBeenNthCalledWith(2, [], { timeout: 60_000 });
    });

    test("uses the fallback model when the primary times out", async () => {
        const primaryModel = makeErrorModel(new DOMException("The operation timed out.", "TimeoutError"));
        const fallbackModel = makeSuccessModel(new AIMessageChunk("fallback ok"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKeys(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(extractContent(result.result.content)).toBe("fallback ok");
        expect(result.usedFallback).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// finishReason reporting — distinguishes a clean stop, a model-reported abnormal
// stop (e.g. SAFETY), and a response that ended with no reason at all
// ---------------------------------------------------------------------------

/** Chunk carrying a finishReason in response_metadata, as Gemini reports it. */
function makeChunkWithFinishReason(finishReason: string): AIMessageChunk {
    return new AIMessageChunk({ content: "partial answer", response_metadata: { finishReason } });
}

describe("ResilientModelInvoker — finishReason", () => {
    test("reports STOP and no interruption on a clean finish", async () => {
        const invoker = makeInvoker();
        const model = makeSuccessModel(makeChunkWithFinishReason("STOP"));

        const result = await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(result.finishReason).toBe(FinishReason.STOP);
        expect(result.wasInterrupted).toBe(false);
    });

    test("surfaces an abnormal reason without flagging an interruption", async () => {
        const invoker = makeInvoker();
        const model = makeSuccessModel(makeChunkWithFinishReason("SAFETY"));

        const result = await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(result.finishReason).toBe(FinishReason.SAFETY);
        // The two signals are mutually exclusive: an interruption is the absence of a reason
        expect(result.wasInterrupted).toBe(false);
    });

    test("reads the reason from additional_kwargs when response_metadata has none", async () => {
        const invoker = makeInvoker();
        const model = makeSuccessModel(
            new AIMessageChunk({ content: "partial", additional_kwargs: { finishReason: "RECITATION" } }),
        );

        const result = await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(result.finishReason).toBe(FinishReason.RECITATION);
    });

    test("flags an interruption and reports no reason when none was sent", async () => {
        const invoker = makeInvoker();
        const model = makeSuccessModel(new AIMessageChunk("truncated answer"));

        const result = await invoker.invokeWithPaidKeys(() => model, undefined, []);

        expect(result.finishReason).toBeNull();
        expect(result.wasInterrupted).toBe(true);
    });

    test("reports the fallback model's reason when the primary 503s", async () => {
        const primaryModel = makeErrorModel(make503Error());
        const fallbackModel = makeSuccessModel(makeChunkWithFinishReason("MAX_TOKENS"));
        const invoker = makeInvoker();

        const result = await invoker.invokeWithPaidKeys(
            () => primaryModel,
            () => fallbackModel,
            [],
        );

        expect(result.usedFallback).toBe(true);
        expect(result.finishReason).toBe(FinishReason.MAX_TOKENS);
        expect(result.wasInterrupted).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Parallel fallback execution — both models run at once, main answer preferred
// ---------------------------------------------------------------------------

/**
 * Model stub whose invoke() settles only when the test resolves or rejects it, and that
 * rejects with an AbortError when its call is aborted, as LangChain does.
 */
function makeControlledModel() {
    const { promise, resolve, reject } = Promise.withResolvers<AIMessage>();
    let signal: AbortSignal | undefined;
    const model = {
        invoke: mock((_messages: BaseMessage[], options?: unknown) => {
            signal = (options as { signal?: AbortSignal } | undefined)?.signal;
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            return promise;
        }),
        stream: mock(async (): Promise<AsyncIterable<AIMessageChunk>> => {
            throw new Error("stream() is not used");
        }),
    } satisfies IInvokableModel;
    return { model, resolve, reject, wasAborted: () => signal?.aborted === true };
}

/** A complete answer, as Gemini reports a clean finish. */
function cleanAnswer(text: string): AIMessage {
    return new AIMessage({ content: text, response_metadata: { finishReason: "STOP" } });
}

/** An answer stopped by a content filter, i.e. visibly truncated. */
function degradedAnswer(text: string): AIMessage {
    return new AIMessage({ content: text, response_metadata: { finishReason: "SAFETY" } });
}

function make429Error() {
    return Object.assign(new Error("Too Many Requests"), { status: 429 });
}

describe("ResilientModelInvoker — parallel fallback execution", () => {
    const parallelInvoker = (freeProvider = makeSingleKeyProvider()) =>
        makeInvoker(freeProvider, makeSingleKeyProvider("paid"), FallbackExecutionMode.parallel);

    test("invokes both models at once and uses the main answer when it arrives first", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        main.resolve(cleanAnswer("main"));

        const result = await parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 1_000 },
        );

        expect(extractContent(result.result.content)).toBe("main");
        expect(result.usedFallback).toBe(false);
        expect(fallback.model.invoke).toHaveBeenCalledTimes(1);
        expect(fallback.wasAborted()).toBe(true);
    });

    test("uses the main answer when it arrives within the grace period after the fallback's", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.resolve(cleanAnswer("fallback"));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 1_000 },
        );
        await sleep(20);
        main.resolve(cleanAnswer("main"));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("main");
        expect(result.usedFallback).toBe(false);
    });

    test("uses the fallback answer and aborts the main call when the grace period expires", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.resolve(cleanAnswer("fallback"));

        const result = await parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 10 },
        );

        expect(extractContent(result.result.content)).toBe("fallback");
        expect(result.usedFallback).toBe(true);
        expect(result.finishReason).toBe(FinishReason.STOP);
        expect(main.wasAborted()).toBe(true);
    });

    test("uses the fallback answer immediately when the main model fails during the grace period", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.resolve(cleanAnswer("fallback"));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 60_000 },
        );
        await sleep(10);
        main.reject(make503Error());
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("fallback");
        expect(result.usedFallback).toBe(true);
    });

    test("does not let a degraded fallback answer short-circuit the main model", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.resolve(new AIMessage({ content: "cut off", response_metadata: { finishReason: "SAFETY" } }));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 10 },
        );
        // Well past the grace period: a clean fallback answer would have been used by now
        await sleep(50);
        main.resolve(cleanAnswer("main"));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("main");
        expect(result.usedFallback).toBe(false);
        expect(main.wasAborted()).toBe(false);
    });

    test("uses a degraded fallback answer when the main model fails", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.resolve(new AIMessage({ content: "cut off", response_metadata: { finishReason: "SAFETY" } }));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 10 },
        );
        await sleep(30);
        main.reject(make503Error());
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("cut off");
        expect(result.usedFallback).toBe(true);
        expect(result.finishReason).toBe(FinishReason.SAFETY);
    });

    test("does not let a degraded main answer short-circuit the fallback model", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        main.resolve(degradedAnswer("main cut off"));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(30);
        fallback.resolve(cleanAnswer("fallback"));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("fallback");
        expect(result.usedFallback).toBe(true);
        expect(fallback.wasAborted()).toBe(false);
    });

    test("uses a degraded main answer when the fallback fails", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        main.resolve(degradedAnswer("main cut off"));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        fallback.reject(make503Error());
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("main cut off");
        expect(result.usedFallback).toBe(false);
        expect(result.finishReason).toBe(FinishReason.SAFETY);
    });

    test.each([
        ["main", "fallback"],
        ["fallback", "main"],
    ] as const)("prefers the main answer when both are degraded (%s answers first)", async (firstModel) => {
        const models = { main: makeControlledModel(), fallback: makeControlledModel() };
        const secondModel = firstModel === "main" ? "fallback" : "main";
        models[firstModel].resolve(degradedAnswer(`${firstModel} cut off`));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => models.main.model,
            () => models.fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        models[secondModel].resolve(degradedAnswer(`${secondModel} cut off`));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("main cut off");
        expect(result.usedFallback).toBe(false);
    });

    test("uses a clean fallback answer over a degraded main answer arriving within the grace period", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.resolve(cleanAnswer("fallback"));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 60_000 },
        );
        await sleep(10);
        main.resolve(degradedAnswer("main cut off"));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("fallback");
        expect(result.usedFallback).toBe(true);
    });

    test("waits for the fallback when the main model fails first, whatever the error", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        // Not a 503/timeout: sequential mode would propagate this without trying the fallback
        main.reject(new Error("400 Bad Request"));

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        fallback.resolve(cleanAnswer("fallback"));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("fallback");
        expect(result.usedFallback).toBe(true);
    });

    test("waits for the main model when the fallback fails first", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        fallback.reject(make503Error());

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        main.resolve(cleanAnswer("main"));
        const result = await pending;

        expect(extractContent(result.result.content)).toBe("main");
        expect(result.usedFallback).toBe(false);
    });

    test.each([
        ["main", "fallback"],
        ["fallback", "main"],
    ] as const)("maps the error of the model that failed last when both fail (%s fails first)", async (firstModel) => {
        const models = { main: makeControlledModel(), fallback: makeControlledModel() };
        const secondModel = firstModel === "main" ? "fallback" : "main";
        const lastErr = makeTimeoutError();
        models[firstModel].reject(make503Error());

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => models.main.model,
            () => models.fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        models[secondModel].reject(lastErr);

        const thrown = await pending.catch((err: unknown) => err);
        expect(thrown).toBeInstanceOf(ModelTimeoutError);
        expect((thrown as ModelTimeoutError).cause).toBe(lastErr);
    });

    test("maps a 503 from the model that failed last to ModelOverloadedError", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        const lastErr = make503Error();
        fallback.reject(makeTimeoutError());

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        main.reject(lastErr);

        const thrown = await pending.catch((err: unknown) => err);
        expect(thrown).toBeInstanceOf(ModelOverloadedError);
        expect((thrown as ModelOverloadedError).cause).toBe(lastErr);
    });

    test("throws the last error unchanged when both fail and it has no model-specific meaning", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        const lastErr = new Error("400 Bad Request");
        main.reject(make503Error());

        const pending = parallelInvoker().invokeWithPaidKeys(
            () => main.model,
            () => fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );
        await sleep(10);
        fallback.reject(lastErr);

        await expect(pending).rejects.toBe(lastErr);
    });

    test("rotates to the next key when both fail and either got a 429", async () => {
        const provider = makeTwoKeyProvider();
        const models = {
            k1: { main: makeControlledModel(), fallback: makeControlledModel() },
            k2: { main: makeControlledModel(), fallback: makeControlledModel() },
        };
        models.k1.main.reject(make429Error());
        models.k1.fallback.reject(make503Error());
        models.k2.main.resolve(cleanAnswer("main on second key"));

        const result = await parallelInvoker(provider).invokeWithFreeKeys(
            (key) => models[key.id as "k1" | "k2"].main.model,
            (key) => models[key.id as "k1" | "k2"].fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );

        expect(extractContent(result.result.content)).toBe("main on second key");
        expect(provider.advanceCount).toBe(1);
    });

    test("rotates to the next key when both fail and either was rejected", async () => {
        const provider = makeTwoKeyProvider();
        const models = {
            k1: { main: makeControlledModel(), fallback: makeControlledModel() },
            k2: { main: makeControlledModel(), fallback: makeControlledModel() },
        };
        models.k1.main.reject(makeKeyRejectedError(403));
        models.k1.fallback.reject(make503Error());
        models.k2.main.resolve(cleanAnswer("main on second key"));

        const result = await makeInvoker(
            makeSingleKeyProvider(),
            provider,
            FallbackExecutionMode.parallel,
        ).invokeWithPaidKeys(
            (key) => models[key.id as "k1" | "k2"].main.model,
            (key) => models[key.id as "k1" | "k2"].fallback.model,
            [],
            { mainGracePeriodMs: 0 },
        );

        expect(extractContent(result.result.content)).toBe("main on second key");
        expect(provider.advanceCount).toBe(1);
    });

    test("throws AllPaidKeysExhaustedError when both fail on the only paid key with a 429", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        main.reject(make429Error());
        fallback.reject(make429Error());

        await expect(
            parallelInvoker().invokeWithPaidKeys(
                () => main.model,
                () => fallback.model,
                [],
                { mainGracePeriodMs: 0 },
            ),
        ).rejects.toBeInstanceOf(AllPaidKeysExhaustedError);
    });

    test("invokes only the main model when the node has no fallback model", async () => {
        const main = makeControlledModel();
        main.resolve(cleanAnswer("main"));

        const result = await parallelInvoker().invokeWithPaidKeys(() => main.model, undefined, [], {
            mainGracePeriodMs: 1_000,
        });

        expect(extractContent(result.result.content)).toBe("main");
        expect(result.usedFallback).toBe(false);
    });
});

describe("ResilientModelInvoker — sequential fallback execution", () => {
    test("does not invoke the fallback model when the main model succeeds", async () => {
        const main = makeSuccessModel(cleanAnswer("main"));
        const fallback = makeSuccessModel(cleanAnswer("fallback"));

        await makeInvoker().invokeWithPaidKeys(
            () => main,
            () => fallback,
            [],
            { mainGracePeriodMs: 1_000 },
        );

        expect(fallback.invoke).not.toHaveBeenCalled();
    });

    test("propagates a non-503/timeout main model error without trying the fallback", async () => {
        const mainErr = new Error("400 Bad Request");
        const fallback = makeSuccessModel(cleanAnswer("fallback"));

        await expect(
            makeInvoker().invokeWithPaidKeys(
                () => makeErrorModel(mainErr),
                () => fallback,
                [],
            ),
        ).rejects.toBe(mainErr);
        expect(fallback.invoke).not.toHaveBeenCalled();
    });

    test("throws ModelOverloadedError wrapping the fallback's error when both models fail with a 503", async () => {
        const fallbackErr = make503Error();

        const thrown = await makeInvoker()
            .invokeWithFreeKeys(
                () => makeErrorModel(make503Error()),
                () => makeErrorModel(fallbackErr),
                [],
            )
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(ModelOverloadedError);
        expect((thrown as ModelOverloadedError).cause).toBe(fallbackErr);
    });

    test("throws ModelTimeoutError when the main model 503s and the fallback times out", async () => {
        const fallbackErr = makeTimeoutError();

        const thrown = await makeInvoker()
            .invokeWithPaidKeys(
                () => makeErrorModel(make503Error()),
                () => makeErrorModel(fallbackErr),
                [],
            )
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(ModelTimeoutError);
        expect((thrown as ModelTimeoutError).cause).toBe(fallbackErr);
    });

    test.each([
        ["503", make503Error, ModelOverloadedError],
        ["timeout", makeTimeoutError, ModelTimeoutError],
    ] as const)(
        "maps a main model %s to a model error when the node has no fallback model",
        async (_label, makeErr, ErrorClass) => {
            const mainErr = makeErr();

            const thrown = await makeInvoker()
                .invokeWithPaidKeys(() => makeErrorModel(mainErr), undefined, [])
                .catch((err: unknown) => err);

            expect(thrown).toBeInstanceOf(ErrorClass);
            expect((thrown as InstanceType<typeof ErrorClass>).cause).toBe(mainErr);
        },
    );
});

// ---------------------------------------------------------------------------
// Provider rejections — responses without candidates and blocked prompts
// ---------------------------------------------------------------------------

/** Mirrors the `@langchain/google` NoCandidatesError. */
function makeNoCandidatesError() {
    return Object.assign(new Error("No candidates returned from API."), { name: "NoCandidatesError" });
}

/** Mirrors the `@langchain/google` PromptBlockedError, which embeds the safety ratings JSON in its message. */
function makePromptBlockedError(safetyRatingsJson = "[]") {
    return Object.assign(new Error(`Prompt was blocked: SAFETY. Safety ratings: ${safetyRatingsJson}`), {
        name: "PromptBlockedError",
        blockReason: "SAFETY",
        safetyRatings: [],
    });
}

describe("ResilientModelInvoker — provider rejections", () => {
    test.each([
        ["no candidates", makeNoCandidatesError],
        ["a blocked prompt", () => makePromptBlockedError()],
    ])("falls back sequentially when the main model returns %s", async (_label, makeErr) => {
        const fallback = makeSuccessModel(cleanAnswer("fallback"));

        const result = await makeInvoker().invokeWithPaidKeys(
            () => makeErrorModel(makeErr()),
            () => fallback,
            [],
        );

        expect(extractContent(result.result.content)).toBe("fallback");
        expect(result.usedFallback).toBe(true);
    });

    test("throws ModelNoCandidatesError when both models return no candidates", async () => {
        const fallbackErr = makeNoCandidatesError();

        const thrown = await makeInvoker()
            .invokeWithPaidKeys(
                () => makeErrorModel(makeNoCandidatesError()),
                () => makeErrorModel(fallbackErr),
                [],
            )
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(ModelNoCandidatesError);
        expect((thrown as ModelNoCandidatesError).cause).toBe(fallbackErr);
    });

    test("throws ModelPromptBlockedError only after both models had the prompt blocked", async () => {
        const fallback = makeErrorModel(makePromptBlockedError());

        const thrown = await makeInvoker()
            .invokeWithPaidKeys(
                () => makeErrorModel(makePromptBlockedError()),
                () => fallback,
                [],
            )
            .catch((err: unknown) => err);

        expect(fallback.invoke).toHaveBeenCalledTimes(1);
        expect(thrown).toBeInstanceOf(ModelPromptBlockedError);
    });

    test("throws ModelPromptBlockedError in parallel mode when both models had the prompt blocked", async () => {
        const main = makeControlledModel();
        const fallback = makeControlledModel();
        main.reject(makePromptBlockedError());
        fallback.reject(makePromptBlockedError());

        const thrown = await makeInvoker(
            makeSingleKeyProvider(),
            makeSingleKeyProvider("paid"),
            FallbackExecutionMode.parallel,
        )
            .invokeWithPaidKeys(
                () => main.model,
                () => fallback.model,
                [],
                { mainGracePeriodMs: 0 },
            )
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(ModelPromptBlockedError);
    });

    // The safety ratings JSON is embedded in the message; rotation must only ever go by status code
    test("never mistakes a blocked prompt mentioning 429 for a rate limit", async () => {
        const provider = makeTwoKeyProvider();
        const blocked = () => makeErrorModel(makePromptBlockedError('[{"probabilityScore":0.1429}]'));

        const thrown = await makeInvoker(provider)
            .invokeWithFreeKeys(blocked, blocked, [])
            .catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(ModelPromptBlockedError);
        expect(provider.advanceCount).toBe(0);
    });
});
