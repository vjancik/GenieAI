import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";

/**
 * A structured content block within a message's content array.
 * All LangChain complex content parts have at least a `type` discriminant.
 */
type ContentBlock = Record<string, unknown> & { type: string };
type InlineAttachmentBlock = ContentBlock & { data: string };

/**
 * Returns true if a content block carries inline binary data (i.e. is an
 * attachment block, not a plain text block). Such blocks have a `data` field
 * containing a base64-encoded string.
 */
function isAttachmentBlock(
    block: ContentBlock,
): block is InlineAttachmentBlock {
    return typeof block.data === "string";
}

/**
 * Returns the byte contribution of an attachment block.
 * We use the base64 string length as a conservative upper bound — actual decoded
 * bytes are ~75% of this, but using length avoids the cost of decoding.
 */
function attachmentBlockBytes(block: InlineAttachmentBlock): number {
    return block.data.length;
}

/**
 * Sums the total byte size of all inline attachment data blocks across an array
 * of messages. Only structured-content HumanMessages are inspected — string-content
 * messages and non-HumanMessages contribute zero.
 *
 * @param messages - The message array to measure
 * @returns Total size in bytes of all inline attachment data fields
 */
export function getInlineAttachmentBytes(messages: BaseMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        // TODO: in the future AIMessages might have inline data too, so we may want to generalize this check beyond HumanMessage
        if (!(msg instanceof HumanMessage)) continue;
        if (!Array.isArray(msg.content)) continue;
        // TYPE COERCION: after Array.isArray, msg.content is MessageContentComplex[] which
        // TypeScript won't implicitly widen to ContentBlock[] (our Record-based local type).
        for (const block of msg.content as ContentBlock[]) {
            if (isAttachmentBlock(block)) {
                total += attachmentBlockBytes(block);
            }
        }
    }
    return total;
}

/**
 * Returns an ephemeral copy of `messages` with inline attachment blocks stripped
 * oldest-first until the total inline data size falls below `maxBytes`.
 *
 * Stripping is per-block (not per-message): within each HumanMessage the blocks
 * are iterated in order, removing one at a time. Once the total drops below the
 * limit the function returns immediately, leaving all remaining blocks intact.
 *
 * Text blocks (`type: "text"`) are never removed — only blocks with a `data` field.
 *
 * Messages that are not HumanMessages, or whose content is a plain string, are
 * never modified and are passed through unchanged.
 *
 * @param messages - The full conversation history to filter
 * @param maxBytes - The inclusive upper bound for total inline attachment data
 * @returns A new array (shallow copy) with filtered HumanMessage instances where needed
 */
export function filterHistoryForInlineSize(
    messages: BaseMessage[],
    maxBytes: number,
): BaseMessage[] {
    let totalBytes = getInlineAttachmentBytes(messages);

    // Fast path: already within budget
    if (totalBytes <= maxBytes) return messages;

    // Work on a shallow copy so we don't mutate the caller's array
    const result: BaseMessage[] = [...messages];

    for (
        let msgIdx = 0;
        msgIdx < result.length && totalBytes > maxBytes;
        msgIdx++
    ) {
        const msg = result[msgIdx];
        // TODO: we should extend this to work on all message types
        if (!(msg instanceof HumanMessage)) continue;
        if (!Array.isArray(msg.content)) continue;

        // TYPE COERCION: after Array.isArray, msg.content is MessageContentComplex[] which
        // TypeScript won't implicitly widen to ContentBlock[] (our Record-based local type).
        const blocks = msg.content as ContentBlock[];
        let modified = false;
        const newBlocks: ContentBlock[] = [];

        for (const block of blocks) {
            if (totalBytes <= maxBytes || !isAttachmentBlock(block)) {
                // Keep: either already within budget, or not an attachment block
                newBlocks.push(block);
            } else {
                // Strip this attachment block and reduce running total
                totalBytes -= attachmentBlockBytes(block);
                modified = true;
            }
        }

        if (modified) {
            // Replace the message with a filtered copy; preserve any other kwargs
            // TODO: if extended to work on all message types, this class will need to be determined dynamically rather than hardcoding HumanMessage
            // TYPE COERCION: ContentBlock[] (our local type) is not directly assignable to
            // MessageContent (LangChain's union); the blocks are valid structured content at runtime.
            result[msgIdx] = new HumanMessage({
                content: newBlocks as MessageContent,
            });
        }
    }

    return result;
}
