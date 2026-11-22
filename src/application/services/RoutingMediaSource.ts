import { isDiscordTokenUrl, isExternalFileUrl } from "../helpers/mediaTokenUrl.ts";
import type { IMediaSource, OpenedMedia } from "../ports/IMediaSource.ts";
import type { Logger } from "../types/Logger.ts";

/** Opens a token URL with the media source responsible for its kind. */
export class RoutingMediaSource implements IMediaSource {
    constructor(
        private readonly discordSource: IMediaSource,
        private readonly externalSource: IMediaSource,
        private readonly logger: Logger,
    ) {}

    /** @returns `null` for a URL that is neither a Discord token nor an external file URL */
    async open(tokenUrl: string, expectedMimeType?: string): Promise<OpenedMedia | null> {
        if (isDiscordTokenUrl(tokenUrl)) return this.discordSource.open(tokenUrl, expectedMimeType);
        if (isExternalFileUrl(tokenUrl)) return this.externalSource.open(tokenUrl, expectedMimeType);

        this.logger.error({ tokenUrl }, "Media token URL is of an unknown kind");
        return null;
    }
}
