import { parseDiscordTokenUrl } from "../helpers/discordTokenUrl.ts";
import { fetchDiscordTokenMedia } from "../helpers/fetchDiscordTokenMedia.ts";
import type { IDiscordMediaService } from "../ports/IDiscordMediaService.ts";
import type { IMediaSource, OpenedMedia } from "../ports/IMediaSource.ts";
import type { IStreamingAttachmentDownloader } from "../ports/IStreamingAttachmentDownloader.ts";
import type { Logger } from "../types/Logger.ts";

/**
 * Opens the media behind `discord://` token URLs: re-fetches the source message for a fresh
 * CDN URL, then streams the media from it.
 */
export class DiscordMediaSource implements IMediaSource {
    constructor(
        private readonly mediaService: IDiscordMediaService,
        private readonly streamingDownloader: IStreamingAttachmentDownloader,
        private readonly logger: Logger,
    ) {}

    /**
     * @returns `null` when the token cannot be parsed or the Discord media was deleted
     * @throws AppError (`ATTACHMENT_DOWNLOAD_FAILED`) when the media exists but cannot be downloaded
     */
    async open(tokenUrl: string, expectedMimeType?: string): Promise<OpenedMedia | null> {
        const token = parseDiscordTokenUrl(tokenUrl);
        if (!token) {
            this.logger.warn({ tokenUrl }, "Cannot parse discord token URL");
            return null;
        }

        const media = await fetchDiscordTokenMedia(this.mediaService, token);
        if (!media) {
            this.logger.warn(
                { tokenUrl, kind: token.kind, discordMessageId: token.messageId },
                "Discord media no longer exists",
            );
            return null;
        }

        const { stream, mimeType, byteLength } = await this.streamingDownloader.downloadStream(media, expectedMimeType);
        return { stream, mimeType, byteLength: byteLength ?? media.size, name: media.name };
    }
}
