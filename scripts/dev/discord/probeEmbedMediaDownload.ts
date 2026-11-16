/**
 * Probes which HTTP client / header combination can actually download the embed
 * media of a Discord message.
 *
 * For every embed media item on the message, each strategy is run against both the
 * original URL and Discord's proxy URL. A download counts as a success only when the
 * body really is media of the expected kind (checked by Content-Type and, for MP4,
 * the `ftyp` box signature) — a 200 with an HTML page is a failure.
 *
 * Usage: bun scripts/dev/discord/probeEmbedMediaDownload.ts <message link> [--json] [--save-dir <dir>]
 *
 * Requires DISCORD_TOKEN (loaded automatically from .env by Bun).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { write } from "bun";
import { Impit } from "impit";
import type { EmbedMedia } from "./extractEmbedMedia.ts";
import { extractEmbedMedia } from "./extractEmbedMedia.ts";

const TIMEOUT_MS = 30_000;

/** Header set a desktop Firefox sends for a top-level media navigation. */
const SPOOFED_BROWSER_HEADERS: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    Accept: "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "video",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
};

/** User agent of Discord's own link-preview crawler; embed-fixer sites key their behavior on it. */
const DISCORDBOT_HEADERS: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
};

/** The slice of a response the probe needs, common to `fetch` and Impit. */
type ProbeResponse = { status: number; finalUrl: string; contentType: string | null; bytes: Uint8Array };

type Strategy = {
    name: string;
    /** What this strategy corresponds to in the code base (or why it is tried). */
    note: string;
    /** True when the request only reveals headers (HEAD, or a one-byte ranged GET), so the body cannot be verified. */
    headersOnly?: boolean;
    run: (url: string, accept: string) => Promise<ProbeResponse>;
};

type ProbeResult = {
    strategy: string;
    target: "url" | "proxyUrl";
    success: boolean;
    status: number | null;
    contentType: string | null;
    bytes: number;
    isMp4: boolean;
    redirectedTo: string | null;
    ms: number;
    error: string | null;
};

/** Runs a request through the platform `fetch`. */
async function viaFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string> },
): Promise<ProbeResponse> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return {
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get("content-type"),
        bytes: new Uint8Array(await response.arrayBuffer()),
    };
}

/** Runs a request through Impit, optionally with a browser fingerprint preset. */
async function viaImpit(
    url: string,
    browser: "firefox" | "chrome" | undefined,
    headers?: Record<string, string>,
): Promise<ProbeResponse> {
    const impit = new Impit({ browser, followRedirects: true, maxRedirects: 20, timeout: TIMEOUT_MS, headers });
    const response = await impit.fetch(url);
    return {
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get("content-type"),
        bytes: new Uint8Array(await response.arrayBuffer()),
    };
}

const STRATEGIES: Strategy[] = [
    {
        name: "fetch / default headers",
        note: "platform fetch, nothing set",
        run: (url) => viaFetch(url, {}),
    },
    {
        name: "fetch / Accept only",
        note: "what FetchAttachmentDownloader and FetchStreamingAttachmentDownloader send for embeds",
        run: (url, accept) => viaFetch(url, { headers: { Accept: accept } }),
    },
    {
        name: "fetch / HEAD",
        note: "the MIME probe in buildLangchainMessage (no body expected)",
        headersOnly: true,
        run: (url) => viaFetch(url, { method: "HEAD" }),
    },
    {
        name: "fetch / HEAD + Discordbot user agent",
        note: "the MIME probe with Discord's crawler user agent",
        headersOnly: true,
        run: (url) => viaFetch(url, { method: "HEAD", headers: DISCORDBOT_HEADERS }),
    },
    {
        name: "fetch / ranged GET + Discordbot user agent",
        note: "one-byte GET as a MIME probe for servers that reject HEAD",
        headersOnly: true,
        run: (url) => viaFetch(url, { headers: { ...DISCORDBOT_HEADERS, Range: "bytes=0-0" } }),
    },
    {
        name: "fetch / spoofed browser headers",
        note: "Firefox user agent, accept and sec-fetch headers on top of Bun's TLS fingerprint",
        run: (url) => viaFetch(url, { headers: SPOOFED_BROWSER_HEADERS }),
    },
    {
        name: "fetch / Discordbot user agent",
        note: "pretends to be Discord's link-preview crawler",
        run: (url) => viaFetch(url, { headers: DISCORDBOT_HEADERS }),
    },
    {
        name: "impit / no preset",
        note: "Impit's own default headers, no browser emulation",
        run: (url) => viaImpit(url, undefined),
    },
    {
        name: "impit / firefox preset",
        note: "Impit's default Firefox headers and TLS fingerprint",
        run: (url) => viaImpit(url, "firefox"),
    },
    {
        name: "impit / chrome preset",
        note: "Impit's default Chrome headers and TLS fingerprint",
        run: (url) => viaImpit(url, "chrome"),
    },
    {
        name: "impit / firefox + accept-language",
        note: "the exact configuration getWebsiteTool uses",
        run: (url) => viaImpit(url, "firefox", { "accept-language": "en-US,en;q=0.9" }),
    },
    {
        name: "impit / firefox + Accept",
        note: "Firefox preset with the downloader's Accept header",
        run: (url, accept) => viaImpit(url, "firefox", { accept }),
    },
    {
        name: "impit / no preset + Discordbot user agent",
        note: "Discord crawler user agent without a browser fingerprint",
        run: (url) => viaImpit(url, undefined, DISCORDBOT_HEADERS),
    },
];

/** True when the bytes start with an ISO base media (`ftyp`) box, i.e. an MP4/MOV container. */
function isMp4(bytes: Uint8Array): boolean {
    return bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp";
}

/** Runs one strategy against one URL and classifies the outcome. */
async function probe(
    strategy: Strategy,
    target: ProbeResult["target"],
    url: string,
    media: EmbedMedia,
    saveDir: string | null,
): Promise<ProbeResult> {
    const expectedCategory = media.mediaKey === "video" ? "video/" : "image/";
    const accept = media.contentType ?? `${expectedCategory}*`;
    const startedAt = performance.now();
    const base = { strategy: strategy.name, target };

    try {
        const response = await strategy.run(url, accept);
        const ms = Math.round(performance.now() - startedAt);
        const mp4 = isMp4(response.bytes);
        const typeMatches = response.contentType?.startsWith(expectedCategory) ?? false;
        const isHead = strategy.headersOnly === true;
        // A headers-only request carries no usable body, so it can only be judged by status and Content-Type
        const bodyOk = isHead || (response.bytes.length > 0 && (media.mediaKey !== "video" || mp4));
        const success = response.status >= 200 && response.status < 300 && typeMatches && bodyOk;

        if (success && saveDir !== null && !isHead) {
            const fileName = `${strategy.name}-${target}`.replace(/[^a-z0-9]+/gi, "_");
            await write(join(saveDir, `${fileName}.${mp4 ? "mp4" : "bin"}`), response.bytes);
        }

        return {
            ...base,
            success,
            status: response.status,
            contentType: response.contentType,
            bytes: response.bytes.length,
            isMp4: mp4,
            redirectedTo: response.finalUrl !== url ? response.finalUrl : null,
            ms,
            error: null,
        };
    } catch (err) {
        return {
            ...base,
            success: false,
            status: null,
            contentType: null,
            bytes: 0,
            isMp4: false,
            redirectedTo: null,
            ms: Math.round(performance.now() - startedAt),
            // Impit surfaces multi-line Rust debug output; the first line is enough here
            error: (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error",
        };
    }
}

function printTable(results: ProbeResult[]): void {
    const rows = results.map((result) => ({
        strategy: result.strategy,
        target: result.target,
        result: result.success ? "OK" : "FAIL",
        status: result.status ?? "-",
        contentType: result.contentType ?? "-",
        bytes: result.bytes,
        mp4: result.isMp4 ? "yes" : "no",
        ms: result.ms,
        detail: result.error ?? (result.redirectedTo ? `-> ${result.redirectedTo.slice(0, 70)}` : ""),
    }));
    console.table(rows);
}

const args = process.argv.slice(2);
const saveDirIndex = args.indexOf("--save-dir");
const saveDir = saveDirIndex === -1 ? null : (args[saveDirIndex + 1] ?? null);
// The value following --save-dir is not the link; without the flag there is no such value to skip
const saveDirValueIndex = saveDirIndex === -1 ? -1 : saveDirIndex + 1;
const link = args.find((arg, index) => !arg.startsWith("--") && index !== saveDirValueIndex);
const token = process.env.DISCORD_TOKEN;

if (link === undefined) {
    console.error(
        "Usage: bun scripts/dev/discord/probeEmbedMediaDownload.ts <message link> [--json] [--save-dir <dir>]",
    );
    process.exit(1);
}
if (!token) throw new Error("DISCORD_TOKEN env var is required");
if (saveDir !== null) await mkdir(saveDir, { recursive: true });

const report: { media: EmbedMedia; results: ProbeResult[] }[] = [];
for (const media of await extractEmbedMedia(link, token)) {
    const targets: [ProbeResult["target"], string | null][] = [
        ["url", media.url],
        ["proxyUrl", media.proxyUrl],
    ];
    const results: ProbeResult[] = [];
    // Sequential on purpose: parallel requests from one IP could trip rate limits and skew the comparison
    for (const [target, url] of targets) {
        if (url === null) continue;
        for (const strategy of STRATEGIES) {
            results.push(await probe(strategy, target, url, media, saveDir));
        }
    }
    report.push({ media, results });
}

if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
} else {
    for (const { media, results } of report) {
        console.log(
            `\n${media.source} embed[${media.embedIndex}] ${media.mediaKey} (${media.contentType ?? "unknown type"})`,
        );
        console.log(`  url:      ${media.url ?? "-"}`);
        console.log(`  proxyUrl: ${media.proxyUrl ?? "-"}`);
        printTable(results);
    }
    console.log("\nStrategies:");
    for (const strategy of STRATEGIES) console.log(`  ${strategy.name} — ${strategy.note}`);
}
