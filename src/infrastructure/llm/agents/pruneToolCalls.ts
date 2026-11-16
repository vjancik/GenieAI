import { AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";

/** Whether a message content block is a raw Gemini `functionCall` part. */
function isFunctionCallBlock(block: unknown): boolean {
    return typeof block === "object" && block !== null && "type" in block && block.type === "functionCall";
}

/**
 * Returns a copy of an AIMessage holding only the given tool calls, so that every call left on
 * the message has a matching ToolMessage. The original message is not modified.
 *
 * A Gemini response stores its calls twice: parsed in `tool_calls`, and as raw `functionCall`
 * blocks in `content`. Both must be pruned, since `tool_calls` drives this application's own
 * processing while the Gemini converter rebuilds replayed history from `content`. Pruning only
 * `tool_calls` would make a later turn replay calls that never got a response.
 *
 * Blocks are matched to calls by position, as both are produced from the same ordered response
 * parts and generated call IDs don't appear in the blocks. A thought signature on a removed block
 * is dropped with it, which is safe because Gemini only validates signatures in the current turn,
 * and pruned messages are only replayed unflattened on later turns.
 *
 * @param message - The triage response to prune
 * @param retainedCalls - The calls to keep, which must be elements of `message.tool_calls`
 * @returns A new AIMessage with the same fields, minus the removed calls
 */
export function pruneToolCalls(message: AIMessage, retainedCalls: ToolCall[]): AIMessage {
    const originalCalls = message.tool_calls ?? [];
    const retained = new Set(retainedCalls);

    let functionCallIndex = 0;
    const content =
        typeof message.content === "string"
            ? message.content
            : message.content.filter((block) => {
                  if (!isFunctionCallBlock(block)) return true;
                  const toolCall = originalCalls[functionCallIndex];
                  functionCallIndex++;
                  return toolCall !== undefined && retained.has(toolCall);
              });

    return new AIMessage({ ...message, content, tool_calls: retainedCalls });
}
