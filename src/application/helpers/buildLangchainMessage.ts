import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { EmbedMediaKey } from "../../domain/message/GeminiFile.ts";
import { EMBED_MEDIA_KEYS } from "../../domain/message/GeminiFile.ts";
import { buildAttachmentTokenUrl, buildEmbedTokenUrl } from "../../infrastructure/discord/discordTokenUrl.ts";
import type { IChatClientMessageAttachment, IChatClientMessageEmbed } from "../ports/chat/IChatClient.ts";
import type { Logger } from "../types/Logger.ts";

/** Returns true if at least one embed contains a URL for any of the tracked media keys. */
function embedsHaveMedia(embeds: IChatClientMessageEmbed[]): boolean {
    return embeds.some((embed) => EMBED_MEDIA_KEYS.some((key) => embed[key]?.url != null));
}

/** Maps each embed media key to the MIME type category prefix it must match. */
const EMBED_KEY_ACCEPT: Record<EmbedMediaKey, string> = {
    image: "image/",
    thumbnail: "image/",
    video: "video/",
};

/**
 * Resolves the MIME type of an embed media URL via an HTTP HEAD request.
 *
 * Returns `null` when the request fails or the response carries no `Content-Type` header.
 * Does not validate the type against any expected category — that is the caller's responsibility.
 */
async function fetchEmbedMimeType(url: string): Promise<string | null> {
    try {
        // TODO: config var for timeout
        const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        const contentType = response.headers.get("content-type");
        if (!contentType) return null;
        // Strip parameters (e.g. "image/jpeg; charset=utf-8" → "image/jpeg")
        return contentType.split(";")[0]?.trim() ?? null;
    } catch {
        return null;
    }
}

/**
 * Builds message content parts as Discord token URL media blocks.
 *
 * Attachment mimeTypes are taken directly from attachment metadata.
 * Embed media mimeTypes are resolved via HEAD request — Discord embed metadata
 * does not carry MIME type information. Embed blocks are skipped when:
 * - the HEAD request fails or returns no Content-Type (embed URLs are flaky)
 * - the resolved MIME type does not match the expected category for the embed key
 *
 * Each attachment and embed media item is encoded as a `discord://` token URL.
 */
async function buildTokenContentParts(
    content: string,
    attachments: IChatClientMessageAttachment[],
    logger: Logger,
    embeds?: IChatClientMessageEmbed[],
    guildId?: string,
    channelId?: string,
    discordMessageId?: string,
): Promise<Array<{ type: "text"; text: string } | { type: "media"; mimeType: string; url: string }>> {
    const mediaBlocks: Array<{ type: "media"; mimeType: string; url: string }> = [];

    for (const attachment of attachments) {
        const mimeType = attachment.contentType;
        if (mimeType === null) {
            logger.error(
                { attachmentId: attachment.id, url: attachment.url, name: attachment.name },
                "Attachment has no Content-Type — skipping block",
            );
            continue;
        }
        const tokenUrl =
            guildId && channelId && discordMessageId
                ? buildAttachmentTokenUrl(guildId, channelId, discordMessageId, attachment.id)
                : attachment.url;
        mediaBlocks.push({ type: "media", mimeType, url: tokenUrl });
    }

    if (embeds) {
        // Collect all embed media candidates first, then HEAD-fetch all concurrently.
        const candidates: { embedIndex: number; key: EmbedMediaKey; url: string; tokenUrl: string }[] = [];
        for (const [embedIndex, embed] of embeds.entries()) {
            for (const key of EMBED_MEDIA_KEYS) {
                const media = embed[key];
                if (!media?.url) continue;
                const tokenUrl =
                    guildId && channelId && discordMessageId
                        ? buildEmbedTokenUrl(guildId, channelId, discordMessageId, embedIndex, key)
                        : media.url;
                candidates.push({ embedIndex, key, url: media.url, tokenUrl });
            }
        }

        const resolved = await Promise.all(
            candidates.map(async ({ embedIndex, key, url, tokenUrl }) => {
                // HEAD-fetch to get the real Content-Type — Discord embed metadata has no MIME type.
                const mimeType = await fetchEmbedMimeType(url);
                if (mimeType === null) {
                    logger.warn(
                        { url, embedIndex, key },
                        "Could not resolve MIME type for embed media via HEAD request — skipping block",
                    );
                    return null;
                }

                // Validate the resolved type matches the category implied by the embed key.
                // A mismatch means the URL is serving unexpected content — skip the block.
                const expected = EMBED_KEY_ACCEPT[key];
                if (!mimeType.startsWith(expected)) {
                    return null;
                }

                return { type: "media" as const, mimeType, url: tokenUrl };
            }),
        );

        for (const block of resolved) {
            if (block !== null) mediaBlocks.push(block);
        }
    }

    // Use legacy LangChain media format with type: "media" rather than specific
    // block types (e.g. "image", "file") via the contentBlocks constructor.
    // See HandleDiscordMessage for detailed rationale.
    return [...(content ? [{ type: "text" as const, text: content }] : []), ...mediaBlocks];
}

// TODO: DI module with config, logger?
/**
 * Constructs a LangChain message from content and optional file attachments.
 * Produces a {@link HumanMessage} for role "human" and an {@link AIMessage} for role "assistant".
 *
 * Attachment mimeTypes are taken from Discord metadata. Embed media mimeTypes are resolved
 * via HTTP HEAD request — Discord embed metadata carries no MIME type information.
 * Embed blocks are skipped when the mimeType cannot be resolved or does not match the
 * expected category for the embed key.
 *
 * Media blocks are encoded as `discord://` token URLs — no full downloads or uploads occur here.
 * `guildId`, `channelId`, and `discordMessageId` are required when attachments or embeds
 * are present; without them the token URL cannot be built and the raw CDN URL is used as a
 * best-effort fallback (the normalizer will not be able to resolve it).
 *
 * Token URL formats:
 *   Attachment:  discord://guildId/channelId/messageId/attachmentId
 *   Embed media: discord://guildId/channelId/messageId/embed/embedIndex/mediaKey
 */
export async function buildLangchainMessage<R extends "human" | "assistant">(params: {
    role: R;
    content: string;
    attachments: IChatClientMessageAttachment[];
    embeds?: IChatClientMessageEmbed[];
    logger: Logger;
    /** Encoded into discord:// token URLs. Required when attachments or embeds are present. */
    guildId?: string;
    /** Encoded into discord:// token URLs. Required when attachments or embeds are present. */
    channelId?: string;
    /** Encoded into discord:// token URLs. Required when attachments or embeds are present. */
    discordMessageId?: string;
}): Promise<R extends "human" ? HumanMessage : AIMessage> {
    const { role, content, attachments, embeds, logger, guildId, channelId, discordMessageId } = params;

    // TYPE COERCION: TypeScript cannot narrow a conditional return type (R extends "human" ? ...)
    // from within the generic implementation body — the union HumanMessage | AIMessage is not
    // assignable to the unresolved conditional type even though it is always correct at runtime.
    const wrap = (contentParts: HumanMessage["content"]) =>
        (role === "human"
            ? new HumanMessage({ content: contentParts })
            : new AIMessage({ content: contentParts })) as R extends "human" ? HumanMessage : AIMessage;

    const hasMedia = attachments.length > 0 || (embeds != null && embedsHaveMedia(embeds));
    if (!hasMedia) {
        return wrap(content);
    }

    return wrap(
        await buildTokenContentParts(content, attachments, logger, embeds, guildId, channelId, discordMessageId),
    );
}
