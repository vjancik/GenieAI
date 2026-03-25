/**
 * Normalizes inline media token URL blocks in LangChain messages.
 *
 * In inline attachment mode, messages are persisted with `{ type: "media", mimeType, url: "discord://..." }`
 * blocks rather than raw base64 payloads. Before passing messages to the LLM, this module
 * resolves those token URLs back into `{ type: "media", mimeType, data: "<base64>" }` blocks
 * by re-fetching fresh CDN URLs from Discord and downloading the bytes.
 *
 * Blocks whose token URL cannot be resolved (e.g. deleted messages) are dropped with a warning.
 * Non-token blocks and non-HumanMessage messages pass through unchanged.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { IAttachmentDownloader } from "../../application/ports/IAttachmentDownloader.ts";
import type { IDiscordMediaService } from "../../application/ports/IDiscordMediaService.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { parseDiscordTokenUrl } from "./discordTokenUrl.ts";

/**
 * A structured content block within a message's content array.
 * All LangChain complex content parts have at least a `type` discriminant.
 */
type ContentBlock = Record<string, unknown> & { type: string };

/** A media block that carries a Discord token URL instead of base64 data. */
type TokenMediaBlock = ContentBlock & { type: "media"; mimeType: string; url: string };

/** A media block that carries resolved base64 data, ready for LLM consumption. */
type DataMediaBlock = ContentBlock & { type: "media"; mimeType: string; data: string };

/** Returns true if the block is an unresolved Discord token URL media block. */
function isTokenMediaBlock(block: ContentBlock): block is TokenMediaBlock {
    return block.type === "media" && typeof block.url === "string" && block.url.startsWith("discord://");
}

/**
 * Resolves a single token media block into a data media block by fetching the
 * attachment or embed media from Discord and downloading the bytes.
 *
 * Returns `null` if the token cannot be parsed or the media can no longer be fetched
 * (e.g. the original message was deleted).
 */
async function resolveTokenBlock(
    block: TokenMediaBlock,
    mediaService: IDiscordMediaService,
    downloader: IAttachmentDownloader,
    logger: Logger,
): Promise<DataMediaBlock | null> {
    const token = parseDiscordTokenUrl(block.url);
    if (!token) {
        logger.warn({ url: block.url }, "Failed to parse Discord token URL in media block — skipping");
        return null;
    }

    let attachment: Awaited<ReturnType<IDiscordMediaService["fetchAttachment"]>>;

    if (token.kind === "attachment") {
        attachment = await mediaService.fetchAttachment(token.channelId, token.messageId, token.attachmentId);
    } else {
        attachment = await mediaService.fetchEmbedMedia(
            token.channelId,
            token.messageId,
            token.embedIndex,
            token.mediaKey,
        );
    }

    if (!attachment) {
        logger.warn(
            { url: block.url, kind: token.kind },
            "Discord media no longer available for inline token block — dropping block",
        );
        return null;
    }

    try {
        const downloaded = await downloader.download(attachment);
        return { type: "media", mimeType: downloaded.mimeType, data: downloaded.data };
    } catch (err) {
        logger.warn(
            { err, url: block.url, name: attachment.name },
            "Failed to download inline media for token block — dropping block",
        );
        return null;
    }
}

/**
 * Walks an array of LangChain messages and resolves any Discord token URL media blocks
 * into base64 data blocks, ready for consumption by the LLM.
 *
 * Only {@link HumanMessage} instances with structured (array) content are inspected.
 * All other messages pass through unchanged. Messages with no token blocks are
 * returned as-is (no copy is made).
 *
 * Blocks that cannot be resolved are dropped with a warning rather than throwing,
 * so a single unavailable attachment does not abort the entire request.
 *
 * @param messages - LangChain messages (history + current turn)
 * @param mediaService - Discord media service for fetching fresh CDN URLs
 * @param downloader - Attachment downloader for fetching byte content
 * @param logger - Logger for warnings on unresolvable tokens
 * @returns A new array with token blocks replaced by resolved data blocks
 */
export async function normalizeInlineMediaBlocks(
    messages: BaseMessage[],
    mediaService: IDiscordMediaService,
    downloader: IAttachmentDownloader,
    logger: Logger,
): Promise<BaseMessage[]> {
    const result: BaseMessage[] = [];

    for (const msg of messages) {
        if (!(msg instanceof HumanMessage) || !Array.isArray(msg.content)) {
            result.push(msg);
            continue;
        }

        // TYPE COERCION: after Array.isArray, msg.content is MessageContentComplex[] which
        // TypeScript won't implicitly widen to ContentBlock[] (our Record-based local type).
        const blocks = msg.content as ContentBlock[];
        const hasTokens = blocks.some(isTokenMediaBlock);

        if (!hasTokens) {
            result.push(msg);
            continue;
        }

        // Resolve all token blocks concurrently — each token is an independent network call.
        const resolvedBlocks = await Promise.all(
            blocks.map(async (block): Promise<ContentBlock | null> => {
                if (!isTokenMediaBlock(block)) return block;
                return resolveTokenBlock(block, mediaService, downloader, logger);
            }),
        );

        // Filter out nulls (dropped blocks) and rebuild the message
        const newContent = resolvedBlocks.filter((b): b is ContentBlock => b !== null);

        // TYPE COERCION: ContentBlock[] (our local type) is not directly assignable to
        // MessageContent (LangChain's union); the blocks are valid structured content at runtime.
        result.push(new HumanMessage({ content: newContent as HumanMessage["content"] }));
    }

    return result;
}
