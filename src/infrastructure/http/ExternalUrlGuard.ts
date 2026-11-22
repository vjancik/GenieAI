import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { WebFetchFailure } from "../../domain/errors/AppError.ts";

/** Which checks the guard applies, mirroring the `externalContent` config section. */
export interface ExternalUrlPolicy {
    /** Only allow `https:` URLs. */
    httpsOnly: boolean;
    /** Refuse hosts that resolve to loopback, private, link-local or otherwise non-public addresses. */
    blockPrivateAddresses: boolean;
}

/** Why a URL was refused, phrased to complete "…: <description>". */
export interface UrlRejection {
    reason: Extract<WebFetchFailure, "insecure-url" | "private-address" | "unreachable">;
    description: string;
}

/** Resolves a host name to all of its IP addresses. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** Checks URLs supplied by users before anything is fetched from them. */
export interface IExternalUrlGuard {
    /**
     * @returns The reason the URL must not be fetched, or `null` when it may be
     */
    check(url: string): Promise<UrlRejection | null>;
}

/** Resolves a host name through the system resolver, the same one the HTTP clients use. */
export async function resolveHostAddresses(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
}

/**
 * Address ranges that are not on the public internet: loopback, private networks, link-local
 * (including the cloud metadata endpoint 169.254.169.254), carrier-grade NAT, documentation,
 * benchmarking, multicast and reserved ranges.
 */
const NON_PUBLIC_IPV4_SUBNETS: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];

/**
 * The IPv6 counterparts, plus NAT64 and 6to4, which embed an IPv4 address and so could reach
 * any IPv4 host. Those two are blocked as a whole rather than unwrapped, as a public host has
 * no reason to resolve to them.
 *
 * IPv4-mapped addresses (`::ffff:a.b.c.d`) are deliberately absent: `BlockList` checks them
 * against the IPv4 subnets above, in both their dotted and hex spellings. Listing
 * `::ffff:0:0/96` here would block every IPv4 address, as `BlockList` represents IPv4
 * addresses in that mapped form internally.
 */
const NON_PUBLIC_IPV6_SUBNETS: [string, number][] = [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
];

function buildNonPublicBlockList(): BlockList {
    const blockList = new BlockList();
    for (const [network, prefix] of NON_PUBLIC_IPV4_SUBNETS) blockList.addSubnet(network, prefix, "ipv4");
    for (const [network, prefix] of NON_PUBLIC_IPV6_SUBNETS) blockList.addSubnet(network, prefix, "ipv6");
    return blockList;
}

const NON_PUBLIC_ADDRESSES = buildNonPublicBlockList();

/** Whether an IP address lies outside the public internet. */
export function isNonPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return false;
    return NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Enforces the external content policy on URLs that users supply: those fetched by the
 * website and video captions tools, every redirect hop the website tool follows, and every
 * later refetch of a file found that way. Discord media is not checked: its URLs come from
 * Discord, not from users.
 *
 * The scheme is checked first, as requiring HTTPS alone already defeats most attempts to
 * reach internal services, which rarely serve valid certificates.
 *
 * The private address check is a best-effort guard against server-side request forgery:
 * a user pointing the bot at `localhost`, the cloud metadata endpoint or another service on
 * the host's network, and getting the response relayed back to them.
 *
 * LIMITATION: the check resolves the host name itself, then the HTTP client resolves it
 * again when connecting. A DNS server that answers differently the second time (DNS
 * rebinding) slips past it. Improvement options, both enforcing the rule at connect time:
 * - Route all outbound fetches through a filtering egress proxy such as Stripe's Smokescreen
 *   (Impit's `proxyUrl`, Playwright's `proxy`, yt-dlp's `--proxy`)
 * - Run the bot on a network with no route to private ranges (Docker network or firewall rules)
 */
export class ExternalUrlGuard implements IExternalUrlGuard {
    constructor(
        private readonly policy: ExternalUrlPolicy,
        private readonly resolveHost: HostResolver = resolveHostAddresses,
    ) {}

    async check(url: string): Promise<UrlRejection | null> {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return { reason: "unreachable", description: "the URL is not valid" };
        }

        if (this.policy.httpsOnly && parsed.protocol !== "https:") {
            return { reason: "insecure-url", description: "only HTTPS URLs are allowed, plain HTTP is not" };
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return { reason: "insecure-url", description: "only HTTP(S) URLs are supported" };
        }

        if (!this.policy.blockPrivateAddresses) return null;
        return this.checkHost(parsed.hostname);
    }

    /**
     * Rejects a host when any address it resolves to is non-public. Checking all of them
     * matters: the client may connect to any one, so a single public decoy proves nothing.
     */
    private async checkHost(hostname: string): Promise<UrlRejection | null> {
        // The URL parser keeps IPv6 literals in brackets; it already normalizes the decimal,
        // octal and hex IPv4 spellings (`http://2130706433/`) to dotted form
        const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

        let addresses: string[];
        if (isIP(host) !== 0) {
            addresses = [host];
        } else {
            try {
                addresses = await this.resolveHost(host);
            } catch {
                return { reason: "unreachable", description: "the host name could not be resolved" };
            }
        }

        if (addresses.length === 0) {
            return { reason: "unreachable", description: "the host name could not be resolved" };
        }
        if (addresses.some(isNonPublicAddress)) {
            return { reason: "private-address", description: "it points to a private or local network address" };
        }
        return null;
    }
}
