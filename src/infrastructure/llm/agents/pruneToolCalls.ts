import { AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";

/** A raw Gemini `functionCall` content block, as stored on a response's `content`. */
interface FunctionCallBlock {
    type: "functionCall";
    functionCall: Record<string, unknown>;
}

/** Whether a message content block is a raw Gemini `functionCall` part. */
function isFunctionCallBlock(block: unknown): block is FunctionCallBlock {
    return (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "functionCall" &&
        "functionCall" in block &&
        typeof block.functionCall === "object" &&
        block.functionCall !== null
    );
}

/**
 * Returns a copy of an AIMessage holding only the retained tool calls, so that every call left
 * on the message has a matching ToolMessage. The original message is not modified.
 *
 * A retained call may be replaced by a rewritten one (e.g. with fewer URLs to fetch), in which
 * case the new arguments are written to both representations of the call.
 *
 * A Gemini response stores its calls twice: parsed in `tool_calls`, and as raw `functionCall`
 * blocks in `content`. Both must be updated, since `tool_calls` drives this application's own
 * processing while the Gemini converter rebuilds replayed history from `content`. Updating only
 * `tool_calls` would make a later turn replay calls that never got a response, or arguments
 * that were never executed.
 *
 * Blocks are matched to calls by position, as both are produced from the same ordered response
 * parts and generated call IDs don't appear in the blocks. A thought signature on a removed block
 * is dropped with it, which is safe because Gemini only validates signatures in the current turn,
 * and pruned messages are only replayed unflattened on later turns.
 *
 * @param message - The triage response to prune
 * @param retainedCalls - Maps each call to keep (an element of `message.tool_calls`) to the call
 *   that takes its place: itself when unchanged, or a rewritten copy. Calls absent from the map
 *   are removed. The message's calls keep the map's order.
 * @returns A new AIMessage with the same fields, minus the removed calls
 */
export function pruneToolCalls(message: AIMessage, retainedCalls: ReadonlyMap<ToolCall, ToolCall>): AIMessage {
    const originalCalls = message.tool_calls ?? [];

    let functionCallIndex = 0;
    const content =
        typeof message.content === "string"
            ? message.content
            : message.content.flatMap((block) => {
                  if (!isFunctionCallBlock(block)) return [block];
                  const original = originalCalls[functionCallIndex];
                  functionCallIndex++;
                  const replacement = original === undefined ? undefined : retainedCalls.get(original);
                  if (replacement === undefined) return [];
                  if (replacement === original) return [block];
                  return [{ ...block, functionCall: { ...block.functionCall, args: replacement.args } }];
              });

    return new AIMessage({ ...message, content, tool_calls: [...retainedCalls.values()] });
}
