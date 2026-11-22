import { Impit } from "impit";

/**
 * Content-negotiation headers.
 *
 * Impit's browser preset already supplies a complete, self-consistent request
 * signature (TLS/JA3 handshake, HTTP/2 settings, and the matching `user-agent`,
 * `accept` and `sec-*` headers). Overriding those made no measurable difference
 * to whether a site served content, so only headers that change *what* the
 * server returns are set here.
 */
const CONTENT_HEADERS: Record<string, string> = {
    "accept-language": "en-US,en;q=0.9",
};

/**
 * Browser fingerprints to try, in order.
 *
 * Firefox is preferred: some sites (NCBI among them) reject Impit's Chrome
 * fingerprint outright. Chrome is the fallback because the two negotiate TLS
 * differently — archive.today's servers pick a cipher suite that the Firefox
 * profile's TLS stack rejects as invalid, while the Chrome profile connects.
 */
export const IMPIT_PROFILES = ["firefox", "chrome"] as const;

export type ImpitProfile = (typeof IMPIT_PROFILES)[number];

/**
 * Minimal in-memory cookie jar matching Impit's `cookieJar` contract.
 *
 * Cookies are grouped by registrable domain (approximated as the last two
 * labels of the host) so a redirect chain that hops between subdomains — as
 * consent interstitials do, e.g. `www.yahoo.com` → `guce.yahoo.com` →
 * `consent.yahoo.com` — carries its session forward.
 *
 * A jar is created per client, so cookies never leak between unrelated requests.
 */
function createCookieJar() {
    const byDomain = new Map<string, Map<string, string>>();
    const registrableDomain = (url: string) => new URL(url).hostname.split(".").slice(-2).join(".");

    return {
        setCookie(cookie: string, url: string): void {
            // Only the leading `name=value` pair matters; attributes are ignored
            const pair = cookie.split(";")[0];
            const separator = pair?.indexOf("=") ?? -1;
            if (!pair || separator < 1) return;
            const domain = registrableDomain(url);
            const cookies = byDomain.get(domain) ?? new Map<string, string>();
            cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
            byDomain.set(domain, cookies);
        },
        getCookieString(url: string): string {
            const cookies = byDomain.get(registrableDomain(url));
            if (!cookies) return "";
            return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        },
    };
}

/**
 * Creates a single-use Impit client impersonating the given browser, with its own cookie jar.
 *
 * Requests go through Impit rather than the platform `fetch`: many publishers reject requests
 * by TLS/HTTP2 fingerprint regardless of how browser-like the headers are.
 *
 * The client does not follow redirects: callers go through `fetchFollowingRedirects`, which
 * checks every hop against the external content policy first. The cookie jar still sees
 * each hop's cookies, as Impit stores them per response.
 *
 * @param browser - The browser fingerprint to present
 * @param timeoutMs - Deadline for a whole request, body included. `null` disables it, which
 *   a download of unknown duration needs; such a caller must bound the request itself.
 */
export function createImpitClient(browser: ImpitProfile, timeoutMs: number | null): Impit {
    return new Impit({
        browser,
        followRedirects: false,
        timeout: timeoutMs,
        cookieJar: createCookieJar(),
        headers: CONTENT_HEADERS,
    });
}
