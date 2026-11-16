/**
 * Request headers for fetching Discord attachment and embed media.
 *
 * Embed media URLs are whatever Discord's link-preview crawler was served, and
 * embed-fixer sites (e.g. Instagram mirrors) key their behavior on its user agent:
 * the crawler gets the media file, every other client — including ones with a
 * browser fingerprint — gets an HTML page or a redirect. Identifying as the same
 * crawler asks for the same response Discord saw. Discord's own CDN ignores it.
 */
export const MEDIA_REQUEST_HEADERS: Readonly<Record<string, string>> = {
    "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
};
