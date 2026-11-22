/**
 * Classification of the token URLs that stand in for media in persisted LangChain messages.
 *
 * A media block is stored as `{ type: "media", mimeType, url }`, where `url` is all that is
 * needed to fetch the media again once its Gemini upload has expired. Two kinds of URLs exist:
 * - `discord://…` tokens address media on a Discord message (see `discordTokenUrl.ts`)
 * - `http(s)://…` URLs address a file on the web, fetched by the website tool
 */

const DISCORD_TOKEN_PREFIX = "discord://";
const EXTERNAL_URL_PATTERN = /^https?:\/\//i;

/** Whether the URL is a `discord://` media token. */
export function isDiscordTokenUrl(url: string): boolean {
    return url.startsWith(DISCORD_TOKEN_PREFIX);
}

/** Whether the URL points at a file on the web rather than at Discord media. */
export function isExternalFileUrl(url: string): boolean {
    return EXTERNAL_URL_PATTERN.test(url);
}
