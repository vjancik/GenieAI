import type { IChatClientMessageAttachment } from "../ports/chat/IChatClientMessageMedia.ts";
import type { IDiscordMediaService } from "../ports/IDiscordMediaService.ts";
import type { DiscordTokenUrl } from "./discordTokenUrl.ts";

/**
 * Re-fetches the media item a parsed `discord://` token URL points at.
 *
 * The single place that maps a token kind to the matching media service call, so
 * every consumer (inline download, first Gemini upload, Gemini re-upload) resolves
 * tokens identically.
 *
 * @param mediaService - Service that re-fetches the source message from Discord
 * @param token - A token parsed by `parseDiscordTokenUrl`
 * @returns The media with a fresh CDN URL, or `null` when the message or media no longer exists
 */
export function fetchDiscordTokenMedia(
    mediaService: IDiscordMediaService,
    token: DiscordTokenUrl,
): Promise<IChatClientMessageAttachment | null> {
    switch (token.kind) {
        case "attachment":
            return mediaService.fetchAttachment(token.channelId, token.messageId, token.attachmentId);
        case "embed":
            return mediaService.fetchEmbedMedia(token.channelId, token.messageId, token.embedIndex, token.mediaKey);
        case "embedComponentMedia":
            return mediaService.fetchEmbedComponentMedia(
                token.channelId,
                token.messageId,
                token.embedIndex,
                token.mediaId,
            );
    }
}
