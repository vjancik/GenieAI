import type { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import type { ApiKeyType } from "../config/AppConfig.ts";
import type { AgentStatusType, OnStatusUpdate } from "../types/AgentStatus.ts";

/** Minimal invokable model interface used by the resilient invoker. */
export interface IInvokableModel {
    invoke(messages: BaseMessage[], options?: unknown): Promise<AIMessageChunk>;
    stream(messages: BaseMessage[], options?: unknown): Promise<AsyncIterable<AIMessageChunk>>;
}

/** Result of a resilient model invocation. */
export interface ModelInvocationResult {
    result: AIMessage;
    /** True when the primary model was unavailable and a fallback model was substituted. */
    usedFallback: boolean;
    /**
     * True when the model stream terminated without a `finishReason` in the final message,
     * indicating a premature upstream termination (e.g. Google dropped the connection or
     * returned a malformed SSE frame). The response content may be incomplete.
     */
    wasInterrupted: boolean;
}

/**
 * Port for resilient LLM invocation with key rotation, retry, fallback, and
 * pre-invocation message preparation (file refresh + attachment filtering).
 *
 * Separates invocation policy from graph orchestration logic.
 */
export interface IResilientModelInvoker {
    /**
     * Invokes a model against the free-key pool with round-robin 429 rotation.
     *
     * - Refreshes Gemini file uploads for each key before invoking.
     * - Filters oversized inline attachments from the message history.
     * - On 429: advances the key cursor and retries up to keyProvider.keyCount times.
     * - On 503/timeout: substitutes the fallback model (same key, same messages).
     *
     * @param getModel           - Factory returning the primary model for a given key
     * @param getFallbackModel   - Factory returning the fallback model for a given key, or undefined
     * @param messages           - Conversation history to invoke the model against
     * @param timeoutMs          - Per-call timeout; falls back to the global timeout when undefined
     * @param onStatusUpdate     - Callback for attachment download/upload status during file refresh
     * @param beforeInvokeStatus - Status to emit immediately before the LLM call, restoring the
     *                             node's phase label after any attachment status update
     *
     * @throws {AllFreeKeysExhaustedError} if all free keys are rate-limited
     */
    invokeWithFreeKeys(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult>;

    /**
     * Invokes a model against the single paid API key.
     *
     * @throws {PaidKeyExhaustedError} if the paid key is rate-limited
     */
    invokeWithPaidKey(
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult>;

    /**
     * Dispatches to {@link invokeWithFreeKeys} or {@link invokeWithPaidKey} based on `keyType`.
     * Prefer this over the individual methods when the key type is a runtime value.
     */
    invoke(
        keyType: ApiKeyType,
        getModel: (key: GeminiApiKey) => IInvokableModel,
        getFallbackModel: ((key: GeminiApiKey) => IInvokableModel | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
        onStatusUpdate?: OnStatusUpdate,
        beforeInvokeStatus?: AgentStatusType,
    ): Promise<ModelInvocationResult>;
}
