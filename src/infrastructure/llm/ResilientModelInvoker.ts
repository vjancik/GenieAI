import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { Span } from "@sentry/core";
import {
    ApiKeyType,
    type AttachmentMode,
    AttachmentMode as AttachmentModeValues,
    FallbackExecutionMode,
} from "../../application/config/AppConfig.ts";
import type { IGeminiMediaNormalizer } from "../../application/ports/IGeminiMediaNormalizer.ts";
import type {
    IInvokableModel,
    IResilientModelInvoker,
    ModelInvocationOptions,
    ModelInvocationResult,
} from "../../application/ports/IResilientModelInvoker.ts";
import type { IRoundRobinKeyProvider } from "../../application/ports/IRoundRobinKeyProvider.ts";
import type { OnStatusUpdate } from "../../application/types/AgentStatus.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import { AllFreeKeysExhaustedError, PaidKeyExhaustedError } from "../../domain/errors/AppError.ts";
import {
    type FinishReason,
    isDegradedFinishReason,
    parseFinishReason,
} from "../../domain/value-objects/FinishReason.ts";
import { is429Error } from "./errors/is429Error.ts";
import { isModelFallbackError } from "./errors/isModelFallbackError.ts";
import { isNoCandidatesError } from "./errors/isNoCandidatesError.ts";
import { isPromptBlockedError } from "./errors/isPromptBlockedError.ts";
import { toModelFailureError } from "./errors/toModelFailureError.ts";
import { filterHistoryForInlineSize } from "./utils/inlineAttachmentFilter.ts";
import { concatMessageChunks, normalizeContent } from "./utils/langchainUtils.ts";

/** A completed model response plus how its generation ended. */
interface ModelCallOutcome {
    message: AIMessage;
    wasInterrupted: boolean;
    finishReason: FinishReason | null;
}

/**
 * Reads the finish reason off a completed message. A missing reason means the upstream
 * terminated prematurely, so the outcome is flagged as interrupted.
 */
function toModelCallOutcome(message: AIMessage): ModelCallOutcome {
    const finishReason = parseFinishReason(
        message.response_metadata?.finishReason ?? message.additional_kwargs?.finishReason,
    );
    return { message, wasInterrupted: finishReason === null, finishReason };
}

/** True when an answer is incomplete or abnormally stopped, i.e. worse than a clean answer. */
function isDegradedOutcome(outcome: ModelCallOutcome): boolean {
    return outcome.wasInterrupted || isDegradedFinishReason(outcome.finishReason);
}

/**
 * Invokes a model with a single non-streaming request, yielding a complete `AIMessage`.
 *
 * Preferred over {@link streamingInvoke}: Google's free tier frequently drops streams
 * mid-generation, leaving fragmented responses, whereas a non-streaming request either
 * returns the whole response or fails outright (503), which the fallback path handles.
 * The trade-off is that `timeoutMs` bounds the entire response rather than the first chunk.
 *
 * `signal` cancels the request early, e.g. when a parallel call's answer is no longer needed.
 */
async function invokeModel(
    model: IInvokableModel,
    messages: BaseMessage[],
    options: { timeoutMs: number; signal?: AbortSignal; span?: Span },
): Promise<ModelCallOutcome> {
    const invokedAt = Date.now();
    const response = await model.invoke(messages, {
        timeout: options.timeoutMs,
        ...(options.signal && { signal: options.signal }),
    });
    options.span?.setAttribute("llm.response_time_ms", Date.now() - invokedAt);

    // Normalize chunks to a plain AIMessage so persisted messages always deserialize as one
    const message = AIMessageChunk.isInstance(response) ? new AIMessage(response.lc_kwargs) : response;
    return toModelCallOutcome(message);
}

/** A model call's result captured as a value, so the call's promise never rejects. */
type SettledCall = { ok: true; outcome: ModelCallOutcome } | { ok: false; error: unknown };

/**
 * Captures a model call's success or failure as a {@link SettledCall}. Used for parallel calls,
 * where the losing call is abandoned and would otherwise surface as an unhandled rejection.
 */
function settle(call: Promise<ModelCallOutcome>): Promise<SettledCall> {
    return call.then(
        (outcome): SettledCall => ({ ok: true, outcome }),
        (error: unknown): SettledCall => ({ ok: false, error }),
    );
}

const GRACE_PERIOD_EXPIRED = Symbol("gracePeriodExpired");

/** Waits for `call` to settle for at most `ms`, resolving with {@link GRACE_PERIOD_EXPIRED} otherwise. */
async function awaitWithin(call: Promise<SettledCall>, ms: number): Promise<SettledCall | typeof GRACE_PERIOD_EXPIRED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof GRACE_PERIOD_EXPIRED>((resolve) => {
        timer = setTimeout(() => resolve(GRACE_PERIOD_EXPIRED), ms);
    });
    try {
        return await Promise.race([call, expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** Error name for log fields, tolerating non-Error throwables. */
function errorName(err: unknown): string {
    return err instanceof Error ? err.name : typeof err;
}

/**
 * True when the error is a 429 that warrants rotating to the next key. Blocked prompts and
 * missing candidates are ruled out first by their exact shape, because `is429Error` scans the
 * error message, which for a blocked prompt embeds arbitrary safety rating JSON.
 */
function isRateLimitError(err: unknown): boolean {
    return !isPromptBlockedError(err) && !isNoCandidatesError(err) && is429Error(err);
}

/**
 * Streams a model, collecting all chunks into a single concatenated `AIMessage`.
 *
 * Currently unused in favor of {@link invokeModel}, kept for when the finer-grained
 * first-chunk timing control is worth the risk of fragmented responses again.
 *
 * - `invokeOptions` is forwarded directly to `model.stream()`.
 * - `firstChunkTimeoutMs` races against the arrival of the first streamed chunk; if no
 *   chunk arrives within that window the stream is cancelled and a TimeoutError is thrown.
 * - `wasInterrupted` is true when the final message carries no `finishReason` in either
 *   `response_metadata` or `additional_kwargs`, indicating a premature upstream termination.
 * - `finishReason` is the reported reason when there is one. Anything other than `STOP`
 *   means generation ended abnormally (e.g. `SAFETY`), leaving a visibly truncated response.
 */
// biome-ignore lint/correctness/noUnusedVariables: intentionally kept as an alternative to invokeModel
async function streamingInvoke(
    model: IInvokableModel,
    messages: BaseMessage[],
    invokeOptions?: unknown,
    extraOptions?: { firstChunkTimeoutMs?: number; span?: Span },
): Promise<ModelCallOutcome> {
    const iterable = await model.stream(messages, invokeOptions);
    const iterator = iterable[Symbol.asyncIterator]();

    /** Cancel the stream and release the underlying fetch connection. Errors are swallowed
     *  since cancellation is best-effort cleanup — the original error takes precedence. */
    const cancelStream = async () => {
        await iterator.return?.().catch(() => undefined);
    };

    // Race the first chunk against firstChunkTimeoutMs. This catches models that
    // accept the request but stall before emitting any output.
    const firstChunkTimeoutMs = extraOptions?.firstChunkTimeoutMs;
    const invokedAt = Date.now();
    let firstResult: IteratorResult<AIMessageChunk>;
    if (firstChunkTimeoutMs !== undefined) {
        const firstChunkTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new DOMException("First chunk timeout", "TimeoutError")), firstChunkTimeoutMs),
        );
        try {
            firstResult = await Promise.race([iterator.next(), firstChunkTimeout]);
        } catch (err) {
            await cancelStream();
            throw err;
        }
    } else {
        firstResult = await iterator.next();
    }

    if (firstResult.done) {
        throw new Error("Model stream completed without emitting any chunks");
    }

    extraOptions?.span?.setAttribute("llm.time_to_first_chunk_ms", Date.now() - invokedAt);

    let collected: AIMessageChunk = new AIMessageChunk({
        ...firstResult.value.lc_kwargs,
        content: normalizeContent(firstResult.value),
    });
    try {
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
            collected = concatMessageChunks(collected, chunk);
        }
    } catch (err) {
        await cancelStream();
        throw err;
    }

    return toModelCallOutcome(new AIMessage(collected.lc_kwargs));
}

/**
 * Outcome of running a node's models against a single API key. Rate limiting is returned
 * rather than thrown so that key rotation is handled in one place, regardless of how the
 * fallback model is executed.
 */
type KeyAttemptOutcome =
    | { kind: "success"; invocation: ModelInvocationResult }
    | { kind: "rateLimited"; error: unknown };

/** Per-key-attempt state shared by the fallback execution strategies. */
interface KeyAttemptContext {
    key: GeminiApiKey;
    attempt: number;
    isPaid: boolean;
    timeoutMs: number;
    span: Span;
}

/** Why parallel execution settled on the answer it returned; recorded on the Sentry span. */
type ParallelDecision =
    | "main_first"
    | "main_within_grace_period"
    | "grace_period_expired"
    | "main_failed"
    | "fallback_failed"
    | "main_degraded"
    | "fallback_degraded"
    | "both_degraded";

function succeeded(outcome: ModelCallOutcome, usedFallback: boolean): KeyAttemptOutcome {
    return {
        kind: "success",
        invocation: {
            result: outcome.message,
            usedFallback,
            wasInterrupted: outcome.wasInterrupted,
            finishReason: outcome.finishReason,
        },
    };
}

/** Invocation policy settings for {@link ResilientModelInvoker}. */
interface ResilientModelInvokerOptions {
    /** How attachments reach the model; inline mode filters oversized attachments from history. */
    attachmentMode: AttachmentMode;
    /** Cumulative inline attachment size limit in bytes, applied in inline mode. */
    maxInlineBytes: number;
    /** Timeout for calls that don't specify their own (ms). */
    globalTimeoutMs: number;
    /** Whether fallback models run after a main model failure or alongside the main model. */
    fallbackExecutionMode: FallbackExecutionMode;
}

/**
 * Implements resilient LLM invocation with key rotation, retry, fallback, and
 * pre-invocation message preparation (Gemini file refresh + inline attachment filtering).
 *
 * Extracted from {@link AgentOrchestrator} so that invocation policy is independently
 * testable and the orchestrator nodes become thin wrappers that prepare messages and delegate.
 */
export class ResilientModelInvoker implements IResilientModelInvoker {
    constructor(
        private readonly freeKeyProvider: IRoundRobinKeyProvider,
        private readonly paidKeyProvider: IRoundRobinKeyProvider,
        private readonly options: ResilientModelInvokerOptions,
        private readonly logger: Logger,
        private readonly fileRefreshService?: IGeminiMediaNormalizer,
    ) {}

    invokeWithFreeKeys(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options?: ModelInvocationOptions,
    ): Promise<ModelInvocationResult> {
        return this.invokeWithKeyRotation(
            getModel,
            getFallbackModel,
            messages,
            options ?? {},
            this.freeKeyProvider,
            false,
        );
    }

    invokeWithPaidKey(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options?: ModelInvocationOptions,
    ): Promise<ModelInvocationResult> {
        return this.invokeWithKeyRotation(
            getModel,
            getFallbackModel,
            messages,
            options ?? {},
            this.paidKeyProvider,
            true,
        );
    }

    invoke(
        keyType: ApiKeyType,
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options?: ModelInvocationOptions,
    ): Promise<ModelInvocationResult> {
        return keyType === ApiKeyType.paid
            ? this.invokeWithPaidKey(getModel, getFallbackModel, messages, options)
            : this.invokeWithFreeKeys(getModel, getFallbackModel, messages, options);
    }

    /**
     * Shared invocation core: runs the node's models against `keyProvider` with file refresh,
     * inline filtering, fallback (per the configured execution mode), and 429 rotation.
     *
     * - Attempt 0 uses the current key (shared cursor, no mutation).
     * - Attempt 1+ calls nextKey(), advancing the shared cursor.
     *
     * @throws {@link AllFreeKeysExhaustedError} if `isPaid` is false and all keys return 429
     * @throws {@link PaidKeyExhaustedError} if `isPaid` is true and the key returns 429
     * @throws For failures that neither rotation nor fallback resolve, the last evaluated model
     *         error immediately, mapped to `ModelOverloadedError` / `ModelTimeoutError`
     *         where applicable (see {@link toModelFailureError})
     */
    private async invokeWithKeyRotation(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options: ModelInvocationOptions,
        keyProvider: IRoundRobinKeyProvider,
        isPaid: boolean,
    ): Promise<ModelInvocationResult> {
        return Sentry.startSpan(
            {
                name: "Invoke model with key rotation",
                op: "llm.invoke",
                attributes: { "llm.fallback_execution_mode": this.options.fallbackExecutionMode },
            },
            async (span) => {
                const timeoutMs = options.timeoutMs ?? this.options.globalTimeoutMs;
                let lastErr: unknown;

                for (let attempt = 0; attempt < keyProvider.keyCount; attempt++) {
                    // Capture the current key before invoking. Because multiple requests
                    // can run concurrently, the cursor may have already been advanced by
                    // another request between when we threw and when we check. Reading
                    // currentKey here ensures each attempt starts with the live cursor.
                    const key = keyProvider.currentKey;

                    const outcome = await this.attemptWithKey(
                        getModel(key),
                        getFallbackModel?.(key),
                        messages,
                        options,
                        {
                            key,
                            attempt,
                            isPaid,
                            timeoutMs,
                            span,
                        },
                    );

                    if (outcome.kind === "rateLimited") {
                        lastErr = outcome.error;
                        // Only advance the cursor if no concurrent request has already
                        // done so. If currentKey has changed since we captured it, a
                        // parallel invocation already rotated to the next key — we must
                        // not skip it by calling nextKey() again.
                        if (keyProvider.currentKey.id === key.id) {
                            keyProvider.nextKey();
                        }
                        continue;
                    }

                    const { invocation } = outcome;
                    span.setAttributes({
                        "llm.attempt_count": attempt + 1,
                        "llm.api_key_id": key.id,
                        "llm.used_fallback": invocation.usedFallback,
                        ...(invocation.finishReason && { "llm.finish_reason": invocation.finishReason }),
                    });
                    return invocation;
                }

                throw isPaid ? new PaidKeyExhaustedError(lastErr) : new AllFreeKeysExhaustedError(lastErr);
            },
        );
    }

    /**
     * Prepares the messages for the attempt's key, then runs the main and fallback models
     * against it using the configured fallback execution mode.
     */
    private async attemptWithKey(
        model: IInvokableModel,
        fallbackModel: IInvokableModel | undefined,
        messages: BaseMessage[],
        options: ModelInvocationOptions,
        context: KeyAttemptContext,
    ): Promise<KeyAttemptOutcome> {
        let prepared: BaseMessage[];
        try {
            prepared = await this.prepareMessages(messages, context.key, options.onStatusUpdate);
        } catch (err) {
            // A rate-limited attachment upload is resolved the same way as a rate-limited model call
            if (isRateLimitError(err)) {
                this.warnRateLimited(context, "attachment preparation");
                return { kind: "rateLimited", error: err };
            }
            throw err;
        }

        // Restore the node's phase label after any attachment status update
        if (options.beforeInvokeStatus !== undefined) {
            options.onStatusUpdate?.({ type: options.beforeInvokeStatus });
        }

        return this.options.fallbackExecutionMode === FallbackExecutionMode.parallel && fallbackModel
            ? this.invokeWithFallbackParallel(model, fallbackModel, prepared, options.mainGracePeriodMs ?? 0, context)
            : this.invokeWithFallbackSequentially(model, fallbackModel, prepared, context);
    }

    /**
     * Normalizes all media blocks for `key` and applies inline attachment filtering:
     * - discord:// token blocks → upload to Gemini (or use cached fileUri)
     * - existing fileUri blocks → validate freshness, re-upload if stale
     * In inline mode the normalization is a no-op (fileRefreshService is not wired).
     */
    private async prepareMessages(
        messages: BaseMessage[],
        key: GeminiApiKey,
        onStatusUpdate: OnStatusUpdate | undefined,
    ): Promise<BaseMessage[]> {
        const refreshed = this.fileRefreshService
            ? await this.fileRefreshService.normalize(messages, key.id, onStatusUpdate)
            : messages;

        return this.options.attachmentMode === AttachmentModeValues.inline
            ? filterHistoryForInlineSize(refreshed, this.options.maxInlineBytes)
            : refreshed;
    }

    /**
     * Invokes the main model, substituting the fallback model (same key, same messages) only
     * when the main model fails with a fallback-eligible error (see {@link isModelFallbackError}).
     *
     * @throws The main model's error when it isn't a 429 and no fallback applies,
     *         or the fallback model's error when it isn't a 429, mapped by {@link toModelFailureError}
     */
    private async invokeWithFallbackSequentially(
        model: IInvokableModel,
        fallbackModel: IInvokableModel | undefined,
        messages: BaseMessage[],
        context: KeyAttemptContext,
    ): Promise<KeyAttemptOutcome> {
        const { timeoutMs, span } = context;

        try {
            return succeeded(await invokeModel(model, messages, { timeoutMs, span }), false);
        } catch (err) {
            if (isRateLimitError(err)) {
                this.warnRateLimited(context, "main model");
                return { kind: "rateLimited", error: err };
            }
            // Only a fallback-eligible error (503, timeout, no candidates, blocked prompt) warrants
            // the fallback; anything else propagates
            if (!isModelFallbackError(err) || !fallbackModel) throw toModelFailureError(err);
            this.logger.warn(
                { attempt: context.attempt, apiKeyId: context.key.id, errName: errorName(err) },
                "Primary model failed with a fallback-eligible error; trying fallback model",
            );
        }

        try {
            return succeeded(await invokeModel(fallbackModel, messages, { timeoutMs, span }), true);
        } catch (fallbackErr) {
            if (isRateLimitError(fallbackErr)) {
                this.warnRateLimited(context, "fallback model");
                return { kind: "rateLimited", error: fallbackErr };
            }
            throw toModelFailureError(fallbackErr);
        }
    }

    /**
     * Invokes the main and fallback models at once on the same key. A clean answer beats a
     * degraded one; between answers of equal quality, the main model's is preferred:
     *
     * - Main succeeds first with a clean answer: it is used and the fallback call is aborted.
     * - Fallback succeeds first with a clean answer: the main model gets `mainGracePeriodMs`
     *   more to finish with a clean answer. If it doesn't, the fallback answer is used and the
     *   main call is aborted.
     * - Either succeeds first with a degraded answer: it can't short-circuit, so the other model
     *   is awaited in full, and the degraded answer is used only if the other doesn't do better.
     * - One fails: the other one's answer is used if it succeeds.
     * - Both fail: rate-limited if either got a 429 (so the next key is tried), otherwise the
     *   error of the model that failed last is thrown, mapped by {@link toModelFailureError}.
     */
    private async invokeWithFallbackParallel(
        model: IInvokableModel,
        fallbackModel: IInvokableModel,
        messages: BaseMessage[],
        mainGracePeriodMs: number,
        context: KeyAttemptContext,
    ): Promise<KeyAttemptOutcome> {
        const { timeoutMs, span } = context;
        const mainAbort = new AbortController();
        const fallbackAbort = new AbortController();

        const mainCall = settle(invokeModel(model, messages, { timeoutMs, signal: mainAbort.signal }));
        const fallbackCall = settle(invokeModel(fallbackModel, messages, { timeoutMs, signal: fallbackAbort.signal }));

        const first = await Promise.race([
            mainCall.then((result) => ({ isMain: true, result }) as const),
            fallbackCall.then((result) => ({ isMain: false, result }) as const),
        ]);

        if (first.isMain) {
            const main = first.result;
            if (main.ok && !isDegradedOutcome(main.outcome)) {
                fallbackAbort.abort();
                return this.parallelResult(main.outcome, false, "main_first", context);
            }
            if (main.ok) {
                // A degraded main answer can't short-circuit the fallback model, only stand in for it
                const fallback = await fallbackCall;
                if (fallback.ok && !isDegradedOutcome(fallback.outcome)) {
                    return this.parallelResult(fallback.outcome, true, "main_degraded", context);
                }
                if (!fallback.ok) this.warnParallelFailure(context, "fallback", fallback.error);
                return this.parallelResult(
                    main.outcome,
                    false,
                    fallback.ok ? "both_degraded" : "fallback_failed",
                    context,
                );
            }
            this.warnParallelFailure(context, "main", main.error);
            const fallback = await fallbackCall;
            if (fallback.ok) return this.parallelResult(fallback.outcome, true, "main_failed", context);
            this.warnParallelFailure(context, "fallback", fallback.error);
            return this.resolveParallelFailure(main.error, fallback.error, context);
        }

        const fallback = first.result;
        if (!fallback.ok) {
            this.warnParallelFailure(context, "fallback", fallback.error);
            const main = await mainCall;
            if (main.ok) return this.parallelResult(main.outcome, false, "fallback_failed", context);
            this.warnParallelFailure(context, "main", main.error);
            return this.resolveParallelFailure(fallback.error, main.error, context);
        }

        if (isDegradedOutcome(fallback.outcome)) {
            // A degraded fallback answer can't short-circuit the main model, only stand in for it
            const main = await mainCall;
            if (main.ok) {
                const decision = isDegradedOutcome(main.outcome) ? "both_degraded" : "fallback_degraded";
                return this.parallelResult(main.outcome, false, decision, context);
            }
            this.warnParallelFailure(context, "main", main.error);
            return this.parallelResult(fallback.outcome, true, "main_failed", context);
        }

        const graceStartedAt = Date.now();
        const main = await awaitWithin(mainCall, mainGracePeriodMs);
        span.setAttribute("llm.parallel.grace_wait_ms", Date.now() - graceStartedAt);

        if (main === GRACE_PERIOD_EXPIRED) {
            mainAbort.abort();
            return this.parallelResult(fallback.outcome, true, "grace_period_expired", context);
        }
        if (main.ok && !isDegradedOutcome(main.outcome)) {
            return this.parallelResult(main.outcome, false, "main_within_grace_period", context);
        }
        if (main.ok) return this.parallelResult(fallback.outcome, true, "main_degraded", context);
        this.warnParallelFailure(context, "main", main.error);
        return this.parallelResult(fallback.outcome, true, "main_failed", context);
    }

    /** Records why parallel execution settled on an answer and wraps it as a successful attempt. */
    private parallelResult(
        outcome: ModelCallOutcome,
        usedFallback: boolean,
        decision: ParallelDecision,
        context: KeyAttemptContext,
    ): KeyAttemptOutcome {
        context.span.setAttribute("llm.parallel.decision", decision);
        this.logger.debug(
            { attempt: context.attempt, apiKeyId: context.key.id, usedFallback, decision },
            "Parallel fallback execution settled",
        );
        return succeeded(outcome, usedFallback);
    }

    /**
     * Resolves a parallel attempt in which both models failed: a 429 from either means the next
     * key may succeed, so the attempt is rate-limited; otherwise the error of the model that
     * failed last is thrown, mapped by {@link toModelFailureError}.
     */
    private resolveParallelFailure(firstErr: unknown, lastErr: unknown, context: KeyAttemptContext): KeyAttemptOutcome {
        const rateLimitErr = [lastErr, firstErr].find(isRateLimitError);
        if (rateLimitErr === undefined) throw toModelFailureError(lastErr);
        this.warnRateLimited(context, "main and fallback models");
        return { kind: "rateLimited", error: rateLimitErr };
    }

    private warnParallelFailure(context: KeyAttemptContext, failedModel: "main" | "fallback", err: unknown): void {
        this.logger.warn(
            { attempt: context.attempt, apiKeyId: context.key.id, failedModel, errName: errorName(err) },
            "Model failed during parallel fallback execution",
        );
    }

    private warnRateLimited(context: KeyAttemptContext, source: string): void {
        this.logger.warn(
            { attempt: context.attempt, apiKeyId: context.key.id, source },
            context.isPaid ? "Paid API key rate-limited (429)" : "Free API key rate-limited (429); trying next key",
        );
    }
}
