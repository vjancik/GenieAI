import type { BaseMessage, MessageContent } from "@langchain/core/messages";

/**
 * A structured content block within a message's content array.
 * All LangChain complex content parts have at least a `type` discriminant.
 */
type ContentBlock = Record<string, unknown> & { type: string };

/** A media block with already-resolved base64 data, ready for LLM consumption. */
type DataAttachmentBlock = ContentBlock & { data: string };

/** A media block still holding a discord:// token URL (data not yet fetched). */
type TokenAttachmentBlock = ContentBlock & { url: string };

/**
 * Returns true if a content block carries resolved base64 binary data.
 * These blocks count toward the inline attachment size budget.
 */
function isDataAttachmentBlock(block: ContentBlock): block is DataAttachmentBlock {
    return typeof block.data === "string";
}

/**
 * Returns true if a content block is an unresolved discord:// token URL block.
 * These blocks have not yet been downloaded; they count as zero bytes toward the budget
 * since their size is unknown until normalization resolves them.
 */
function isTokenAttachmentBlock(block: ContentBlock): block is TokenAttachmentBlock {
    return typeof block.url === "string" && block.url.startsWith("discord://");
}

/**
 * Returns true if a block is any kind of attachment block (data or token).
 * Used to identify blocks that should be stripped when trimming history.
 */
function isAttachmentBlock(block: ContentBlock): block is DataAttachmentBlock | TokenAttachmentBlock {
    return isDataAttachmentBlock(block) || isTokenAttachmentBlock(block);
}

/**
 * Returns the byte contribution of an attachment block.
 * Token URL blocks contribute zero — their size is unknown until normalization.
 * Data blocks use base64 string length as a conservative upper bound (actual decoded
 * bytes are ~75% of this, but using length avoids the cost of decoding).
 */
function attachmentBlockBytes(block: DataAttachmentBlock | TokenAttachmentBlock): number {
    if (isDataAttachmentBlock(block)) return block.data.length;
    return 0;
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
 * Text blocks (`type: "text"`) are never removed — only attachment blocks (data or token URL).
 *
 * Messages that are not HumanMessages, or whose content is a plain string, are
 * never modified and are passed through unchanged.
 *
 * @param messages - The full conversation history to filter
 * @param maxBytes - The inclusive upper bound for total inline attachment data
 * @returns A new array (shallow copy) with filtered HumanMessage instances where needed
 */
export function filterHistoryForInlineSize(messages: BaseMessage[], maxBytes: number): BaseMessage[] {
    let totalBytes = getInlineAttachmentBytes(messages);

    // Fast path: already within budget
    if (totalBytes <= maxBytes) return messages;

    // Work on a shallow copy so we don't mutate the caller's array
    const result: BaseMessage[] = [...messages];

    for (let msgIdx = 0; msgIdx < result.length && totalBytes > maxBytes; msgIdx++) {
        const msg = result[msgIdx];
        if (!msg) continue;
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
            // Reconstruct using the same subclass as the original message, preserving all
            // other fields (id, name, additional_kwargs, response_metadata).
            // TYPE COERCION: msg.constructor is typed as Function; cast to a newable signature
            // matching BaseMessage's constructor so TypeScript allows the instantiation.
            // ContentBlock[] (our local type) is not directly assignable to MessageContent
            // (LangChain's union); the blocks are valid structured content at runtime.
            result[msgIdx] = new (msg.constructor as new (fields: object) => BaseMessage)({
                ...msg,
                content: newBlocks as MessageContent,
            });
        }
    }

    return result;
}
