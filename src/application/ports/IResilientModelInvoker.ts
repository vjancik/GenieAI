import type { BaseMessage } from "@langchain/core/messages";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

/** Minimal invokable model interface used by the resilient invoker. */
export interface InvokableModel<T extends BaseMessage> {
    invoke(messages: BaseMessage[], options?: unknown): Promise<T>;
}

/** Result of a resilient model invocation. */
export interface ModelInvocationResult<T extends BaseMessage> {
    result: T;
    /** True when the primary model was unavailable and a fallback model was substituted. */
    usedFallback: boolean;
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
     * @param getModel         - Factory returning the primary model for a given key
     * @param getFallbackModel - Factory returning the fallback model for a given key, or undefined
     * @param messages         - Conversation history to invoke the model against
     * @param timeoutMs        - Per-call timeout; falls back to the global timeout when undefined
     *
     * @throws {AllFreeKeysExhaustedError} if all free keys are rate-limited
     */
    invokeWithFreeKeys<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => InvokableModel<T>,
        getFallbackModel: ((key: GeminiApiKey) => InvokableModel<T> | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
    ): Promise<ModelInvocationResult<T>>;

    /**
     * Invokes a model against the single paid API key.
     *
     * @throws {PaidKeyExhaustedError} if the paid key is rate-limited
     */
    invokeWithPaidKey<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => InvokableModel<T>,
        getFallbackModel: ((key: GeminiApiKey) => InvokableModel<T> | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
    ): Promise<ModelInvocationResult<T>>;
}
