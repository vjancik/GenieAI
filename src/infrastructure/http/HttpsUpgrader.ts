import type { Impit } from "impit";
import type { Logger } from "../../application/types/Logger.ts";
import type { IExternalUrlGuard } from "./ExternalUrlGuard.ts";
import { createImpitClient, IMPIT_PROFILES, type ImpitProfile } from "./impitClient.ts";

/** Rewrites plain HTTP URLs that users supply to HTTPS, where the host supports it. */
export interface IHttpsUpgrader {
    /**
     * @returns The HTTPS form of the URL when its host serves HTTPS with a valid certificate,
     *   otherwise the URL unchanged
     */
    upgrade(url: string): Promise<string>;
}

/** Whether a host answers an HTTPS URL over a TLS connection with a valid certificate. */
export type HttpsProbe = (httpsUrl: string) => Promise<boolean>;

/** Creates the client a probe request goes through, see {@link createImpitClient}. */
type ProbeClientFactory = (browser: ImpitProfile, timeoutMs: number) => Pick<Impit, "fetch">;

/** Short, as a host without HTTPS often drops connections to port 443 rather than refusing them. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probes an HTTPS URL with a HEAD request. Any HTTP response counts, error statuses and
 * redirects included: it proves the TLS handshake succeeded, and Impit verifies certificates
 * by default, so an invalid certificate fails the request.
 *
 * Both browser fingerprints are tried, as some servers only complete the handshake with one
 * of them (see {@link IMPIT_PROFILES}). They run in parallel so that a host that drops the
 * connection costs one timeout rather than two.
 *
 * @param httpsUrl - The URL to probe
 * @param createClient - Creates the HTTP client per fingerprint, injectable for tests
 */
export async function probeHttps(
    httpsUrl: string,
    createClient: ProbeClientFactory = createImpitClient,
): Promise<boolean> {
    try {
        await Promise.any(
            IMPIT_PROFILES.map(async (browser) => {
                const response = await createClient(browser, PROBE_TIMEOUT_MS).fetch(httpsUrl, {
                    method: "HEAD",
                    redirect: "manual",
                });
                await response.body?.cancel().catch(() => undefined);
            }),
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * Upgrades plain HTTP URLs that users supply to HTTPS when the host serves HTTPS, so that
 * sites reachable both ways are fetched securely and pass the HTTPS-only policy.
 *
 * Only the URL as supplied is upgraded. Redirects the server sends are taken as they are, and
 * left to the URL guard: the server chose them, so a redirect to plain HTTP means the site
 * does not serve that page over HTTPS.
 *
 * URLs with an explicit port are not upgraded: that port serves plain HTTP, and HTTPS on the
 * same port is unlikely.
 */
export class HttpsUpgrader implements IHttpsUpgrader {
    /**
     * @param logger - Logs each upgrade decision at debug level
     * @param urlGuard - Checked before probing, so that the probe never reaches a host the
     *   external content policy refuses (a private address, for instance)
     * @param probe - Decides whether the host serves HTTPS, injectable for tests
     */
    constructor(
        private readonly logger: Logger,
        private readonly urlGuard?: IExternalUrlGuard,
        private readonly probe: HttpsProbe = probeHttps,
    ) {}

    async upgrade(url: string): Promise<string> {
        let candidate: URL;
        try {
            candidate = new URL(url);
        } catch {
            return url;
        }
        if (candidate.protocol !== "http:" || candidate.port !== "") return url;
        candidate.protocol = "https:";
        const httpsUrl = candidate.toString();

        // A refused host stays refused over plain HTTP too, so leave the verdict to the guard
        const rejection = await this.urlGuard?.check(httpsUrl);
        if (rejection) return url;

        const upgradable = await this.probe(httpsUrl);
        this.logger.debug({ url, upgradable }, "Probed plain HTTP URL for an HTTPS upgrade");
        return upgradable ? httpsUrl : url;
    }
}

/** The URL a user-supplied URL is fetched from, and the original when it was upgraded. */
export type UpgradedUrl = { url: string } | { url: string; upgradedFrom: string };

/**
 * Upgrades a user-supplied URL if an upgrader is configured.
 *
 * @returns The URL to fetch, with `upgradedFrom` set to the supplied URL when they differ, so
 *   that results can be matched to the URL the user gave
 */
export async function upgradeSuppliedUrl(url: string, upgrader: IHttpsUpgrader | undefined): Promise<UpgradedUrl> {
    const upgraded = (await upgrader?.upgrade(url)) ?? url;
    return upgraded === url ? { url } : { url: upgraded, upgradedFrom: url };
}
