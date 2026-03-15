/**
 * HTTP utility for resolving redirect URLs.
 *
 * Used to unwrap long click-tracking URLs (e.g. Google grounding links)
 * into their canonical destination before displaying them in Discord.
 */

/**
 * Follows a URL redirect exactly once using a HEAD request and returns the
 * resolved `Location` header value, or `null` if the request fails or there
 * is no redirect.
 *
 * Uses `redirect: "manual"` so the fetch does not auto-follow; we inspect
 * the Location header ourselves to avoid following a chain of redirects.
 *
 * @param url - The URL to resolve
 */
async function unwrapRedirect(url: string): Promise<string | null> {
    try {
        const response = await fetch(url, {
            method: "HEAD",
            redirect: "manual",
        });
        return response.headers.get("location");
    } catch {
        return null;
    }
}

/**
 * Resolves a redirect URL and returns whichever is shorter: the resolved
 * destination or the original URL.
 *
 * Falls back to the original URL if the redirect cannot be resolved.
 *
 * @param url - The URL to shorten via redirect resolution
 */
export async function shortenRedirectUrl(url: string): Promise<string> {
    const resolved = await unwrapRedirect(url);
    if (!resolved) return url;
    return resolved.length < url.length ? resolved : url;
}
