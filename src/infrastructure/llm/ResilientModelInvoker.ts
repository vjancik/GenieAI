import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { Span } from "@sentry/core";
import {
    ApiKeyType,
    type AttachmentMode,
    AttachmentMode as AttachmentModeValues,
} from "../../application/config/AppConfig.ts";
import type { IGeminiMediaNormalizer } from "../../application/ports/IGeminiMediaNormalizer.ts";
import type {
    IInvokableModel,
    IResilientModelInvoker,
    ModelInvocationResult,
} from "../../application/ports/IResilientModelInvoker.ts";
import type { IRoundRobinKeyProvider } from "../../application/ports/IRoundRobinKeyProvider.ts";
import type { AgentStatusType, OnStatusUpdate } from "../../application/types/AgentStatus.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import { AllFreeKeysExhaustedError, PaidKeyExhaustedError } from "../../domain/errors/AppError.ts";
import { is429Error } from "./errors/is429Error.ts";
import { isModelFallbackError } from "./errors/isModelFallbackError.ts";
import { filterHistoryForInlineSize } from "./utils/inlineAttachmentFilter.ts";
import { concatMessageChunks, normalizeContent } from "./utils/langchainUtils.ts";

/**
 * Streams a model, collecting all chunks into a single concatenated `AIMessage`.
 *
 * - `invokeOptions` is forwarded directly to `model.stream()`.
 * - `firstChunkTimeoutMs` races against the arrival of the first streamed chunk; if no
 *   chunk arrives within that window the stream is cancelled and a TimeoutError is thrown.
 */
async function streamingInvoke(
    model: IInvokableModel,
    messages: BaseMessage[],
    invokeOptions?: unknown,
    extraOptions?: { firstChunkTimeoutMs?: number; span?: Span },
): Promise<AIMessage> {
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

    return new AIMessage(collected.lc_kwargs);
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
        private readonly attachmentMode: AttachmentMode,
        private readonly maxInlineBytes: number,
        private readonly globalTimeoutMs: number,
        private readonly logger: Logger,
        private readonly fileRefreshService?: IGeminiMediaNormalizer,
    ) {}

    invokeWithFreeKeys(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult> {
        return this.invokeWithKeyRotation(
            getModel,
            getFallbackModel,
            messages,
            timeoutMs,
            this.freeKeyProvider,
            false,
            onStatusUpdate,
            beforeInvokeStatus,
        );
    }

    invokeWithPaidKey(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult> {
        return this.invokeWithKeyRotation(
            getModel,
            getFallbackModel,
            messages,
            timeoutMs,
            this.paidKeyProvider,
            true,
            onStatusUpdate,
            beforeInvokeStatus,
        );
    }

    invoke(
        keyType: ApiKeyType,
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult> {
        return keyType === ApiKeyType.paid
            ? this.invokeWithPaidKey(
                  getModel,
                  getFallbackModel,
                  messages,
                  timeoutMs,
                  onStatusUpdate,
                  beforeInvokeStatus,
              )
            : this.invokeWithFreeKeys(
                  getModel,
                  getFallbackModel,
                  messages,
                  timeoutMs,
                  onStatusUpdate,
                  beforeInvokeStatus,
              );
    }

    /**
     * Shared invocation core: runs the model against `keyProvider` with file refresh,
     * inline filtering, 503/timeout fallback, and 429 rotation.
     *
     * - Attempt 0 uses the current key (shared cursor, no mutation).
     * - Attempt 1+ calls nextKey(), advancing the shared cursor.
     *
     * @throws {@link AllFreeKeysExhaustedError} if `isPaid` is false and all keys return 429
     * @throws {@link PaidKeyExhaustedError} if `isPaid` is true and the key returns 429
     * @throws The original error immediately for non-429 / non-fallback failures
     */
    private async invokeWithKeyRotation(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs: number | undefined,
        keyProvider: IRoundRobinKeyProvider,
        isPaid: boolean,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult> {
        return Sentry.startSpan(
            {
                name: "Invoke model with key rotation",
                op: "llm.invoke",
            },
            async (span) => {
                let lastErr: unknown;

                for (let attempt = 0; attempt < keyProvider.keyCount; attempt++) {
                    // Capture the current key before invoking. Because multiple requests
                    // can run concurrently, the cursor may have already been advanced by
                    // another request between when we threw and when we check. Reading
                    // currentKey here ensures each attempt starts with the live cursor.
                    const key = keyProvider.currentKey;

                    let filtered: BaseMessage[] = [];
                    try {
                        // Normalize all media blocks before invoking:
                        // - discord:// token blocks → upload to Gemini (or use cached fileUri)
                        // - existing fileUri blocks → validate freshness, re-upload if stale
                        // In inline mode this is a no-op (fileRefreshService is not wired).
                        const refreshed = this.fileRefreshService
                            ? await this.fileRefreshService.normalize(messages, key.id, onStatusUpdate)
                            : messages;

                        filtered =
                            this.attachmentMode === AttachmentModeValues.inline
                                ? filterHistoryForInlineSize(refreshed, this.maxInlineBytes)
                                : refreshed;

                        // Restore the node's phase label after any attachment status update
                        if (beforeInvokeStatus !== undefined) {
                            onStatusUpdate?.({ type: beforeInvokeStatus });
                        }

                        const result = await streamingInvoke(getModel(key), filtered, undefined, {
                            firstChunkTimeoutMs: timeoutMs ?? this.globalTimeoutMs,
                            span,
                        });
                        span.setAttributes({
                            "llm.attempt_count": attempt + 1,
                            "llm.api_key_id": key.id,
                        });
                        return { result, usedFallback: false };
                    } catch (err) {
                        if (is429Error(err)) {
                            this.logger.warn(
                                { attempt, apiKeyId: key.id },
                                isPaid
                                    ? "Paid API key rate-limited (429)"
                                    : "Free API key rate-limited (429); trying next key",
                            );
                            lastErr = err;
                            // Only advance the cursor if no concurrent request has already
                            // done so. If currentKey has changed since we captured it, a
                            // parallel invocation already rotated to the next key — we must
                            // not skip it by calling nextKey() again.
                            if (keyProvider.currentKey.id === key.id) {
                                keyProvider.nextKey();
                            }
                            continue;
                        }

                        // On 503 or timeout: try the fallback model with the same key and timeout.
                        // If no fallback is configured, or the fallback also fails, propagate.
                        if (isModelFallbackError(err) && getFallbackModel) {
                            const fallbackModel = getFallbackModel(key);
                            if (!fallbackModel) throw err;
                            this.logger.warn(
                                { attempt, apiKeyId: key.id, errName: (err as Error).name },
                                "Primary model failed with 503/timeout; trying fallback model",
                            );
                            try {
                                // Reuse filtered — same key, same messages, no re-refresh needed
                                const fallbackResult = await streamingInvoke(fallbackModel, filtered, undefined, {
                                    firstChunkTimeoutMs: timeoutMs ?? this.globalTimeoutMs,
                                    span,
                                });
                                span.setAttributes({
                                    "llm.attempt_count": attempt + 1,
                                    "llm.api_key_id": key.id,
                                    "llm.used_fallback": true,
                                });
                                return { result: fallbackResult, usedFallback: true };
                            } catch (fallbackErr) {
                                if (is429Error(fallbackErr)) {
                                    this.logger.warn(
                                        { attempt, apiKeyId: key.id },
                                        isPaid
                                            ? "Paid API key rate-limited on fallback model (429)"
                                            : "Free API key rate-limited on fallback model (429); trying next key",
                                    );
                                    lastErr = fallbackErr;
                                    if (keyProvider.currentKey.id === key.id) {
                                        keyProvider.nextKey();
                                    }
                                    continue;
                                }
                                throw fallbackErr;
                            }
                        }

                        // Non-429, non-fallback error: propagate immediately without trying other keys
                        throw err;
                    }
                }

                throw isPaid ? new PaidKeyExhaustedError(lastErr) : new AllFreeKeysExhaustedError(lastErr);
            },
        );
    }
}
