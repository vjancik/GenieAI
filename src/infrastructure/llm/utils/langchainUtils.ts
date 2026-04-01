/**
 * Workarounds for upstream @langchain/core bugs in AIMessageChunk streaming.
 *
 * Bug: AIMessageChunk.concat() fails to merge adjacent text blocks that appear
 * after a non-standard content block (e.g. executableCode, inlineData). The
 * upstream mergeContent() only merges text runs at the head of the array; once
 * a non-text block appears, subsequent text blocks are left as separate entries.
 *
 * @see tests/unit/llm/langchainBugs.test.ts for regression coverage
 */

import { AIMessageChunk } from "@langchain/core/messages";

/** A content block as returned by @langchain/core — an open record with a `type` discriminant. */
type ContentBlock = Record<string, unknown> & { type: string };

/**
 * Normalizes a single chunk's content to an array of ContentBlock objects.
 *
 * When the upstream library produces a string-content chunk (e.g. a plain-text
 * streaming delta), it stores the original structured block in
 * `additional_kwargs.originalTextContentBlock`. We prefer that over a synthetic
 * `{ type: "text", text: "..." }` block so that `thoughtSignature` and other
 * metadata carried on the original block are preserved.
 *
 * Also exported so callers can normalize a single-chunk stream that never goes
 * through {@link concatMessageChunks}.
 */
export function normalizeContent(chunk: AIMessageChunk): ContentBlock[] {
    const original = chunk.additional_kwargs?.originalTextContentBlock;
    const hasOriginal = original !== null && original !== undefined && typeof original === "object";

    if (typeof chunk.content === "string") {
        if (hasOriginal) return [original as ContentBlock];
        return [{ type: "text", text: chunk.content }];
    }

    if (!Array.isArray(chunk.content)) {
        throw new Error(`concatMessageChunks: unexpected content type "${typeof chunk.content}"`);
    }

    // If originalTextContentBlock carries a thoughtSignature, stamp it onto the first
    // text block in the array — the array may have mixed block types so we iterate.
    const originalSignature = hasOriginal ? (original as ContentBlock).thoughtSignature : undefined;
    if (originalSignature !== undefined) {
        const blocks = chunk.content as ContentBlock[];
        const firstTextIndex = blocks.findIndex((b) => b.type === "text");
        if (firstTextIndex !== -1) {
            const patched = [...blocks];
            patched[firstTextIndex] = {
                ...patched[firstTextIndex],
                thoughtSignature: originalSignature,
            } as ContentBlock;
            return patched;
        }
    }

    return chunk.content;
}

/**
 * Merges two normalized content arrays into one, coalescing adjacent text blocks.
 *
 * Two text blocks are merged (text concatenated) unless both carry a
 * `thoughtSignature` — in that case they are kept separate because each signature
 * corresponds to a distinct reasoning span and must not be conflated.
 */
function joinNormalizedContents(blocksA: ContentBlock[], blocksB: ContentBlock[]): ContentBlock[] {
    return [...blocksA, ...blocksB].reduce<ContentBlock[]>((acc, block) => {
        const prev = acc[acc.length - 1];

        if (
            prev?.type === "text" &&
            block.type === "text" &&
            // Keep separate if both already carry independent thought signatures
            !(prev.thoughtSignature !== undefined && block.thoughtSignature !== undefined)
        ) {
            // Merge: append text and carry the incoming thoughtSignature if present
            const merged: ContentBlock = {
                ...prev,
                text: String(prev.text ?? "") + String(block.text ?? ""),
            };
            if (block.thoughtSignature !== undefined) {
                merged.thoughtSignature = block.thoughtSignature;
            }
            acc[acc.length - 1] = merged;
            return acc;
        }

        acc.push(block);
        return acc;
    }, []);
}

// NOTE: Workaround util function until upstream bug gets fixed
//       https://github.com/langchain-ai/langchainjs/issues/10562

/**
 * Concatenates two AIMessageChunks, fixing the upstream bug where text blocks
 * following a non-standard content block (e.g. executableCode, inlineData) are
 * not merged by the default `.concat()` implementation.
 *
 * All other chunk fields (tool_calls, usage_metadata, response_metadata, etc.)
 * are handled by the upstream `.concat()` — we only replace the content array.
 */
export function concatMessageChunks(chunkA: AIMessageChunk, chunkB: AIMessageChunk): AIMessageChunk {
    const upstream = chunkA.concat(chunkB);

    const mergedContent = joinNormalizedContents(normalizeContent(chunkA), normalizeContent(chunkB));

    return new AIMessageChunk({
        ...upstream.lc_kwargs,
        content: mergedContent,
    });
}
