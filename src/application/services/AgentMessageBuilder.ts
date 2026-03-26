import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { EMBED_MEDIA_KEYS } from "../../domain/message/GeminiFile.ts";
import { buildAttachmentTokenUrl, buildEmbedTokenUrl } from "../../infrastructure/discord/discordTokenUrl.ts";
import type { IChatClientMessageAttachment, IChatClientMessageEmbed } from "../ports/chat/IChatClient.ts";
import type { Logger } from "../types/Logger.ts";

/** Returns true if at least one embed contains a URL for any of the tracked media keys. */
function embedsHaveMedia(embeds: IChatClientMessageEmbed[]): boolean {
    return embeds.some((embed) => EMBED_MEDIA_KEYS.some((key) => embed[key]?.url != null));
}

/**
 * Application service: constructs LangChain messages from chat content and file attachments.
 *
 * Mode-agnostic — always produces `{ type: "media", mimeType, url: "discord://..." }` token
 * URL blocks regardless of attachment mode. Actual resolution (inline base64 or Gemini upload)
 * is delegated to the appropriate normalizer at LLM-call time.
 *
 * Token URL formats:
 *   Attachment:  discord://guildId/channelId/messageId/attachmentId
 *   Embed media: discord://guildId/channelId/messageId/embed/embedIndex/mediaKey
 */
export class AgentMessageBuilder {
    constructor(private readonly logger: Logger) {}

    /**
     * Constructs a LangChain message from content and optional file attachments.
     * Produces a {@link HumanMessage} for role "human" and an {@link AIMessage} for role "assistant".
     *
     * Media blocks are encoded as `discord://` token URLs — no downloads or uploads occur here.
     * `guildId`, `channelId`, and `discordMessageId` are required when attachments or embeds
     * are present; without them the token URL cannot be built and the raw CDN URL is used as a
     * best-effort fallback (the normalizer will not be able to resolve it).
     */
    /**
     * Constructs a LangChain message from content and optional file attachments.
     * Produces a {@link HumanMessage} for role "human" and an {@link AIMessage} for role "assistant".
     *
     * Media blocks are encoded as `discord://` token URLs — no downloads or uploads occur here.
     * `guildId`, `channelId`, and `discordMessageId` are required when attachments or embeds
     * are present; without them the token URL cannot be built and the raw CDN URL is used as a
     * best-effort fallback (the normalizer will not be able to resolve it).
     */
    buildMessage<R extends "human" | "assistant">(params: {
        role: R;
        content: string;
        attachments: IChatClientMessageAttachment[];
        embeds?: IChatClientMessageEmbed[];
        /** Encoded into discord:// token URLs. Required when attachments or embeds are present. */
        guildId?: string;
        /** Encoded into discord:// token URLs. Required when attachments or embeds are present. */
        channelId?: string;
        /** Encoded into discord:// token URLs. Required when attachments or embeds are present. */
        discordMessageId?: string;
    }): {
        msg: R extends "human" ? HumanMessage : AIMessage;
    } {
        const { role, content, attachments, embeds, guildId, channelId, discordMessageId } = params;

        // TYPE COERCION: TypeScript cannot narrow a conditional return type (R extends "human" ? ...)
        // from within the generic implementation body — the union HumanMessage | AIMessage is not
        // assignable to the unresolved conditional type even though it is always correct at runtime.
        const wrap = (contentParts: HumanMessage["content"]) =>
            (role === "human"
                ? new HumanMessage({ content: contentParts })
                : new AIMessage({ content: contentParts })) as R extends "human" ? HumanMessage : AIMessage;

        const hasMedia = attachments.length > 0 || (embeds != null && embedsHaveMedia(embeds));
        if (!hasMedia) {
            return { msg: wrap(content) };
        }

        return {
            msg: wrap(this.buildTokenContentParts(content, attachments, embeds, guildId, channelId, discordMessageId)),
        };
    }

    /**
     * Builds message content parts as Discord token URL media blocks.
     *
     * Each attachment and embed media item is encoded as a `discord://` token URL.
     * No network calls are made — resolution is fully deferred to the normalizer.
     */
    private buildTokenContentParts(
        content: string,
        attachments: IChatClientMessageAttachment[],
        embeds?: IChatClientMessageEmbed[],
        guildId?: string,
        channelId?: string,
        discordMessageId?: string,
    ): Array<{ type: "text"; text: string } | { type: "media"; mimeType: string; url: string }> {
        const mediaBlocks: Array<{ type: "media"; mimeType: string; url: string }> = [];

        for (const attachment of attachments) {
            const mimeType = attachment.contentType ?? "application/octet-stream";
            const tokenUrl =
                guildId && channelId && discordMessageId
                    ? buildAttachmentTokenUrl(guildId, channelId, discordMessageId, attachment.id)
                    : attachment.url;
            mediaBlocks.push({ type: "media", mimeType, url: tokenUrl });
        }

        if (embeds) {
            for (const [embedIndex, embed] of embeds.entries()) {
                for (const key of EMBED_MEDIA_KEYS) {
                    const media = embed[key];
                    if (!media?.url) continue;
                    const tokenUrl =
                        guildId && channelId && discordMessageId
                            ? buildEmbedTokenUrl(guildId, channelId, discordMessageId, embedIndex, key)
                            : media.url;
                    // MIME type is not available from embed metadata; resolved on download
                    mediaBlocks.push({ type: "media", mimeType: "application/octet-stream", url: tokenUrl });
                }
            }
        }

        this.logger.debug({ count: mediaBlocks.length }, "Built media token blocks (resolution deferred)");

        // Use legacy LangChain media format with type: "media" rather than specific
        // block types (e.g. "image", "file") via the contentBlocks constructor.
        // See HandleDiscordMessage for detailed rationale.
        return [...(content ? [{ type: "text" as const, text: content }] : []), ...mediaBlocks];
    }
}
