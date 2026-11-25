import { AIMessage, type BaseMessage, type UsageMetadata } from "@langchain/core/messages";

/** Multipliers applied to token categories when charging usage against a token rate limit. */
export interface TokenUsageWeights {
    /** Multiplier for input tokens served from the context cache (`input_token_details.cache_read`). */
    cachedTokensWeight: number;
    /** Multiplier for output tokens, which include thinking tokens. */
    outputTokensWeight: number;
}

/**
 * Returns the usage metadata of the last AI message in `messages`, or null when none carries any.
 *
 * Under the triage → answering-node agent structure the final AI message comes from the answering
 * call, whose input already includes the full history and tool results, so it dominates a turn's cost.
 */
export function lastAiUsageMetadata(messages: readonly BaseMessage[]): UsageMetadata | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (AIMessage.isInstance(message) && message.usage_metadata) return message.usage_metadata;
    }
    return null;
}

/**
 * Converts token usage into the weighted amount charged against a token rate limit:
 *
 * `input_tokens - cache_read + cache_read * cachedTokensWeight + output_tokens * outputTokensWeight`
 *
 * Cached input is discounted (it's cheaper to serve) and output is weighted up (it's pricier to
 * generate). `cache_read` is clamped to `input_tokens` so a malformed report can't go negative.
 *
 * @param usage - LangChain usage metadata from a model response
 * @param weights - Multipliers for cached input and output tokens
 */
export function weighTokenUsage(usage: UsageMetadata, weights: TokenUsageWeights): number {
    const cacheRead = Math.min(usage.input_token_details?.cache_read ?? 0, usage.input_tokens);
    return (
        usage.input_tokens -
        cacheRead +
        cacheRead * weights.cachedTokensWeight +
        usage.output_tokens * weights.outputTokensWeight
    );
}
