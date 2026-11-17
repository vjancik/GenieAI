import type { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import type { FinishReason } from "../../domain/value-objects/FinishReason.ts";
import type { ApiKeyType } from "../config/AppConfig.ts";
import type { AgentStatusType, OnStatusUpdate } from "../types/AgentStatus.ts";

/** Minimal invokable model interface used by the resilient invoker. */
export interface IInvokableModel {
    /** LangChain types this as a chunk, but non-streaming providers (e.g. ChatGoogle) return a plain `AIMessage`. */
    invoke(messages: BaseMessage[], options?: unknown): Promise<AIMessage | AIMessageChunk>;
    stream(messages: BaseMessage[], options?: unknown): Promise<AsyncIterable<AIMessageChunk>>;
}

/** Result of a resilient model invocation. */
export interface ModelInvocationResult {
    result: AIMessage;
    /** True when the primary model was unavailable and a fallback model was substituted. */
    usedFallback: boolean;
    /**
     * True when the final message carries no `finishReason`, indicating a premature upstream
     * termination (e.g. Google dropped the connection or returned a malformed SSE frame while
     * streaming). The response content may be incomplete.
     *
     * Mutually exclusive with a non-null {@link finishReason}: an interruption is precisely
     * the absence of a reported reason.
     */
    wasInterrupted: boolean;
    /**
     * The reason the model reported for ending generation, or null when none was reported
     * (see {@link wasInterrupted}). Anything other than `STOP` means the response is degraded,
     * e.g. `SAFETY` for a visibly truncated answer stopped by a content filter.
     */
    finishReason: FinishReason | null;
}

/** Per-call options for a resilient model invocation. */
export interface ModelInvocationOptions {
    /** Per-call timeout in ms; falls back to the global timeout when undefined. */
    timeoutMs?: number;
    /**
     * Parallel fallback mode only: how long the main model is given to finish after the fallback
     * model has answered successfully, in ms. Treated as 0 when undefined.
     */
    mainGracePeriodMs?: number;
    /** Callback for attachment download/upload status during file refresh. */
    onStatusUpdate?: OnStatusUpdate;
    /**
     * Status to emit immediately before the LLM call, restoring the node's phase label
     * after any attachment status update.
     */
    beforeInvokeStatus?: AgentStatusType;
}

/**
 * Port for resilient LLM invocation with key rotation, retry, fallback, and
 * pre-invocation message preparation (file refresh + attachment filtering).
 *
 * Separates invocation policy from graph orchestration logic.
 */
export interface IResilientModelInvoker {
    /**
     * Invokes a model against the free-key pool with round-robin key rotation.
     *
     * - Refreshes Gemini file uploads for each key before invoking.
     * - Filters oversized inline attachments from the message history.
     * - When the key is rejected (401, 402, 403) or rate-limited (429): advances the key cursor
     *   and retries up to keyProvider.keyCount times.
     * - Fallback (same key, same messages), depending on the configured execution mode:
     *   - sequential: substituted when the main model fails with a 503, timeout, response without
     *     candidates, or blocked prompt.
     *   - parallel: run alongside the main model; its answer is used when the main model fails or
     *     answers degraded, or hasn't answered within the grace period after the fallback did.
     *     A degraded answer from either model never preempts the other model.
     *
     * @param getModel         - Factory returning the primary model for a given key
     * @param getFallbackModel - Factory returning the fallback model for a given key, or undefined
     * @param messages         - Conversation history to invoke the model against
     * @param options          - Per-call timeout, grace period, and status reporting
     *
     * @throws {AllFreeKeysExhaustedError} if all free keys are rejected or rate-limited
     * @throws {ModelOverloadedError} if the last evaluated model call was rejected with a 503
     * @throws {ModelTimeoutError} if the last evaluated model call timed out or was aborted
     * @throws {ModelNoCandidatesError} if the last evaluated model call returned no candidates
     * @throws {ModelPromptBlockedError} if the last evaluated model call had its prompt blocked
     */
    invokeWithFreeKeys(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options?: ModelInvocationOptions,
    ): Promise<ModelInvocationResult>;

    /**
     * Invokes a model against the paid-key pool. Behaves like {@link invokeWithFreeKeys},
     * including key rotation and fallback, but over the paid keys.
     *
     * @throws {AllPaidKeysExhaustedError} if all paid keys are rejected or rate-limited
     * @throws {ModelOverloadedError} if the last evaluated model call was rejected with a 503
     * @throws {ModelTimeoutError} if the last evaluated model call timed out or was aborted
     * @throws {ModelNoCandidatesError} if the last evaluated model call returned no candidates
     * @throws {ModelPromptBlockedError} if the last evaluated model call had its prompt blocked
     */
    invokeWithPaidKeys(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options?: ModelInvocationOptions,
    ): Promise<ModelInvocationResult>;

    /**
     * Dispatches to {@link invokeWithFreeKeys} or {@link invokeWithPaidKeys} based on `keyType`.
     * Prefer this over the individual methods when the key type is a runtime value.
     */
    invoke(
        keyType: ApiKeyType,
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        options?: ModelInvocationOptions,
    ): Promise<ModelInvocationResult>;
}
