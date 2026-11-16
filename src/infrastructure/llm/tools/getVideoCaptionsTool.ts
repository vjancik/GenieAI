import { tool } from "@langchain/core/tools";
import { spawn } from "bun";
import { z } from "zod";
import type { Logger } from "../../../application/types/Logger.ts";
import { ToolName } from "../../../application/types/ToolName.ts";
import { NoCaptionsError, ToolError } from "../../../domain/errors/AppError.ts";

/**
 * Zod schema for a single caption track entry from yt-dlp's info JSON.
 * `protocol` is only present on streaming entries (e.g. m3u8_native).
 */
const CaptionEntrySchema = z.object({
    ext: z.string(),
    url: z.string(),
    name: z.string().optional(),
    protocol: z.string().optional(),
});

/**
 * Zod schema for the yt-dlp --dump-single-json output fields we consume.
 * Exported for use in tests to validate fixture files against the same schema.
 * Only the fields needed for caption URL selection are validated; the rest
 * of the (large) info JSON is ignored. Both caption maps default to empty
 * objects to handle providers that omit one or both fields.
 */
export const InfoJsonSchema = z.object({
    id: z.string(),
    title: z.string().optional(),
    channel: z.string().optional(),
    uploader: z.string().optional(),
    subtitles: z.record(z.string(), z.array(CaptionEntrySchema)).default({}),
    automatic_captions: z.record(z.string(), z.array(CaptionEntrySchema)).default({}),
});

/** Shape of a single caption track entry from yt-dlp's info JSON. */
export type YtDlpCaptionEntry = z.infer<typeof CaptionEntrySchema>;

/** Relevant subset of the yt-dlp --dump-single-json output. */
export type YtDlpInfoJson = z.infer<typeof InfoJsonSchema>;

/** Successful result for a single video URL captions fetch. */
export type VideoCaptionsResult = { url: string; videoCaptions: string; title?: string; author?: string };
/**
 * Error result for a single video URL captions fetch. `title` and `author` are present
 * when the metadata was retrieved but the video has no usable captions.
 */
export type VideoCaptionsError = { url: string; error: string; title?: string; author?: string };
/** Union result type returned per URL by the video captions tool. */
export type VideoCaptionsResultEntry = VideoCaptionsResult | VideoCaptionsError;

/**
 * Priority-ordered list of language prefixes (most preferred first).
 * Any language matching these prefixes is preferred over unlisted ones.
 */
const LANG_PRIORITY_PREFIXES = ["en", "de", "fr", "it", "es", "ko", "zh", "hi"];

/**
 * Caption formats in preference order.
 * srt/vtt are plain-text with timestamps; ttml is XML but structured;
 * srv3/srv2/srv1 are YouTube XML variants (srv3 has word-level timing, srv1 is simplest);
 * json3 is raw JSON requiring custom parsing — least useful as a transcript.
 */
const FORMAT_PRIORITY = ["srt", "vtt", "ttml", "srv3", "srv2", "srv1", "json3"];

/**
 * Returns a numeric priority score for a language code (lower = higher priority).
 * Languages matching LANG_PRIORITY_PREFIXES are scored by their index;
 * all others get a fallback score after the list.
 */
function langScore(lang: string): number {
    const idx = LANG_PRIORITY_PREFIXES.findIndex(
        (prefix) => lang === prefix || lang.startsWith(`${prefix}-`) || lang.startsWith(`${prefix}_`),
    );
    return idx === -1 ? LANG_PRIORITY_PREFIXES.length : idx;
}

/**
 * Returns a numeric priority score for a caption format (lower = higher priority).
 * Formats not in FORMAT_PRIORITY get a fallback score after the list.
 */
function formatScore(ext: string): number {
    const idx = FORMAT_PRIORITY.indexOf(ext);
    return idx === -1 ? FORMAT_PRIORITY.length : idx;
}

/**
 * Builds a priority-ordered list of caption URLs from yt-dlp info JSON.
 *
 * Ordering rules (ascending priority = earlier in result = preferred):
 *   1. Manual subtitles before automatic captions
 *   2. Language priority: en.* > de.*, fr.*, it.*, es.*, ko.*, zh.*, hi.* > any
 *   3. Format priority: srt > vtt > any
 *
 * Excludes entries using non-HTTP protocols (e.g. m3u8_native HLS streams),
 * as those cannot be fetched directly with a simple HTTP request.
 *
 * @param info - Parsed yt-dlp info JSON object
 * @returns Ordered array of URLs to try (most preferred first)
 */
export function selectCaptionUrls(info: YtDlpInfoJson): string[] {
    interface Candidate {
        url: string;
        isAuto: number; // 0 = manual, 1 = auto
        lang: string;
        ext: string;
    }

    const candidates: Candidate[] = [];

    const collect = (map: Record<string, YtDlpCaptionEntry[]>, isAuto: number) => {
        for (const [lang, entries] of Object.entries(map)) {
            for (const entry of entries) {
                // Skip HLS/DASH streaming protocols — not directly fetchable
                if (entry.protocol && entry.protocol !== "https" && entry.protocol !== "http") continue;
                // Skip auto-translated tracks (tlang param) — YouTube rate-limits these aggressively
                if (new URL(entry.url).searchParams.has("tlang")) continue;
                candidates.push({ url: entry.url, isAuto, lang, ext: entry.ext });
            }
        }
    };

    collect(info.subtitles, 0);
    collect(info.automatic_captions, 1);

    candidates.sort((a, b) => {
        if (a.isAuto !== b.isAuto) return a.isAuto - b.isAuto;
        const langDiff = langScore(a.lang) - langScore(b.lang);
        if (langDiff !== 0) return langDiff;
        return formatScore(a.ext) - formatScore(b.ext);
    });

    // Deduplicate by URL then cap at top 5 manual + top 5 auto to avoid
    // excessive fallback attempts across hundreds of translated tracks
    const seen = new Set<string>();
    let manualCount = 0;
    let autoCount = 0;
    return candidates.reduce<string[]>((acc, c) => {
        const count = c.isAuto === 0 ? manualCount : autoCount;
        if (!seen.has(c.url) && count < 5) {
            seen.add(c.url);
            if (c.isAuto === 0) manualCount++;
            else autoCount++;
            acc.push(c.url);
        }
        return acc;
    }, []);
}

/**
 * Verifies yt-dlp is available in PATH by running `yt-dlp --version`.
 * Throws a ToolError if the command is not found or exits non-zero.
 */
async function verifyYtDlp(): Promise<void> {
    const proc = spawn(["yt-dlp", "--version"], { stderr: "pipe", stdout: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) {
        throw new ToolError("yt-dlp is not available in PATH and is required for video captions");
    }
}

/**
 * Verifies deno is available in PATH by running `deno --version`.
 * Throws a ToolError if the command is not found or exits non-zero.
 */
async function verifyDeno(): Promise<void> {
    const proc = spawn(["deno", "--version"], { stderr: "pipe", stdout: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) {
        throw new ToolError("deno is not available in PATH and is required for video captions");
    }
}

/**
 * Maps an error thrown while processing a video URL to the entry reported back to the model.
 * A {@link NoCaptionsError} is forwarded verbatim along with the video's title and author,
 * since it is a definitive answer the user should hear. Other failures are reported
 * generically, as their details (stderr, proxy errors) aren't meaningful to the user.
 *
 * @param url - The video URL that failed
 * @param err - The thrown error
 */
export function toVideoCaptionsError(url: string, err: unknown): VideoCaptionsError {
    if (err instanceof NoCaptionsError) {
        return {
            url,
            error: err.message,
            ...(err.title !== null && { title: err.title }),
            ...(err.author !== null && { author: err.author }),
        };
    }
    return { url, error: `Failed to retrieve captions for ${url}` };
}

/** Counts every caption track in the metadata, before any filtering. */
function countCaptionTracks(info: YtDlpInfoJson): number {
    return [...Object.values(info.subtitles), ...Object.values(info.automatic_captions)].reduce(
        (total, entries) => total + entries.length,
        0,
    );
}

/** Settings for the video captions tool, mirroring the `ytDlp` config section. */
interface VideoCaptionsToolOptions {
    /** Optional HTTP/HTTPS proxy URL passed to yt-dlp and caption fetches. */
    httpProxy?: string | undefined;
    /** Number of proxy rotation retries on IP-related and transient network failures. */
    retries: number;
    /** Hard cap in milliseconds on a whole tool call, including all retries. */
    timeoutMs: number;
}

/**
 * Throws a ToolError if the tool call's overall deadline has passed. Called before each
 * attempt, and after each failure so that a process killed by the deadline isn't
 * mistaken for an ordinary yt-dlp failure.
 */
function throwIfDeadlineExceeded(deadline: AbortSignal): void {
    if (deadline.aborted) {
        throw new ToolError("Video captions fetch exceeded the ytDlp.timeoutMs deadline", deadline.reason);
    }
}

/**
 * Creates a LangChain tool that fetches captions from video URLs using yt-dlp.
 *
 * Verifies yt-dlp is available in PATH before returning the tool. Throws if not
 * found, since it is a hard runtime requirement with no fallback.
 *
 * If `proxy` is provided, validates it uses http:// or https:// (the only schemes
 * yt-dlp's --proxy flag and Bun's fetch support) and passes it to all yt-dlp
 * invocations and caption fetch requests.
 *
 * TODO: support configurable yt-dlp binary path for Windows compatibility
 * TODO: use dynamic tool registration to gracefully omit the tool when yt-dlp is unavailable
 *
 * For each URL, yt-dlp dumps the video metadata JSON (-J) to stdout. The metadata
 * is parsed to build a priority-ordered list of caption URLs (manual > auto,
 * preferred languages first, srt > vtt). URLs are tried in order until one
 * returns a successful response, handling transient 429s gracefully.
 *
 * Each tool call is capped at `timeoutMs` overall: once it elapses, running yt-dlp
 * processes are killed, in-flight caption requests are aborted, and every URL that
 * hasn't finished yet resolves to an error entry.
 *
 * @param logger - Injectable logger for testability
 * @param options - Proxy, retry and timeout settings (from the `ytDlp` config section)
 */
export async function createGetVideoCaptionsTool(logger: Logger, options: VideoCaptionsToolOptions) {
    const { httpProxy: proxy, retries: proxyRetries, timeoutMs } = options;
    if (proxy !== undefined) {
        const scheme = new URL(proxy).protocol;
        if (scheme !== "http:" && scheme !== "https:") {
            throw new ToolError(`ytDlp.httpProxy must use http:// or https://, got: ${scheme}`);
        }
    }
    await Promise.all([verifyYtDlp(), verifyDeno()]);
    return tool(
        async ({ urls }): Promise<VideoCaptionsResultEntry[]> => {
            // Deduplicate URLs to avoid redundant yt-dlp invocations
            const unique = [...new Set(urls)];
            logger.debug({ urls: unique, timeoutMs }, "Fetching video captions");

            // One deadline shared by all URLs, so the whole call is capped at timeoutMs
            const deadline = AbortSignal.timeout(timeoutMs);
            const results = await Promise.allSettled(
                unique.map((url) => extractCaptions(url, logger, deadline, proxy, proxyRetries)),
            );

            return results.map((result, i) => {
                if (result.status === "fulfilled") {
                    return result.value;
                }
                const url = unique[i] ?? "unknown";
                const entry = toVideoCaptionsError(url, result.reason);
                if (result.reason instanceof NoCaptionsError) {
                    logger.info({ url, error: result.reason.message }, "Video has no usable captions");
                } else {
                    const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
                    logger.warn({ url, error }, "Failed to fetch video captions");
                }
                return entry;
            });
        },
        {
            name: ToolName.GET_VIDEO_CAPTIONS,
            description:
                "Fetch captions/subtitles from video URLs (YouTube, social media, etc.). " +
                "Use this when the user provides URLs pointing to video content they want summarized or analyzed.",
            schema: z.object({
                urls: z.array(z.url()).min(1).describe("Video URLs to fetch captions for"),
            }),
        },
    );
}

/**
 * Patterns in yt-dlp stderr indicating a failure tied to the current exit IP, or a
 * transient network/proxy problem, either of which a fresh rotating-proxy connection
 * can resolve. Apostrophes are matched with `.` because yt-dlp relays YouTube's
 * messages verbatim, and those use a typographic apostrophe (U+2019).
 */
const PROXY_RETRYABLE_PATTERNS: readonly RegExp[] = [
    // YouTube bot detection and IP-level throttling
    /confirm you.re not a bot/i,
    /content isn.t available, try again later/i,
    /HTTP Error 429/i,
    // Proxy and connection-level failures (5xx tunnel errors only — a 407 means bad credentials)
    /unable to connect to proxy/i,
    /tunnel connection failed: 5\d\d/i,
    /timed out/i,
    /connection (?:reset|refused|aborted)/i,
    /remote end closed connection/i,
    /IncompleteRead/i,
    /EOF occurred in violation of protocol/i,
];

/**
 * Returns whether a yt-dlp failure is worth retrying through a rotating proxy,
 * i.e. it is IP-related (bot detection, throttling) or a transient network error.
 *
 * @param stderr - The stderr output of the failed yt-dlp invocation
 */
export function isProxyRetryableYtDlpError(stderr: string): boolean {
    return PROXY_RETRYABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** Outcome of a single yt-dlp process run. */
export interface YtDlpRunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

/** yt-dlp process operations used by the metadata fetch, injectable for testing. */
export interface YtDlpMetadataRunner {
    /** Runs the metadata dump command once. */
    runMetadata(): Promise<YtDlpRunResult>;
    /** Runs `yt-dlp --update`, resolving to whether a new version was installed. */
    update(): Promise<boolean>;
}

// TODO: config var
const PROXY_SOCKET_TIMEOUT_SEC = "20";
const DEFAULT_SOCKET_TIMEOUT_SEC = "10";

/**
 * Creates a runner that spawns real yt-dlp processes for the given video URL.
 *
 * @param url - The video URL to dump metadata for
 * @param deadline - Kills any running yt-dlp process when aborted
 * @param proxy - Optional HTTP/HTTPS proxy URL passed via --proxy
 */
function createSpawnYtDlpRunner(url: string, deadline: AbortSignal, proxy?: string): YtDlpMetadataRunner {
    const proxyArgs = proxy ? ["--proxy", proxy] : [];
    const socketTimeout = proxy ? PROXY_SOCKET_TIMEOUT_SEC : DEFAULT_SOCKET_TIMEOUT_SEC;
    return {
        async runMetadata() {
            // --flat-playlist: fail fast on playlists rather than fetching all entries
            const proc = spawn(
                [
                    "yt-dlp",
                    "--no-warnings",
                    "--flat-playlist",
                    "--socket-timeout",
                    socketTimeout,
                    ...proxyArgs,
                    "-J",
                    url,
                ],
                {
                    stderr: "pipe",
                    stdout: "pipe",
                    signal: deadline,
                },
            );
            const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            return { stdout, exitCode: proc.exitCode, stderr };
        },
        async update() {
            const proc = spawn(["yt-dlp", "--update"], { stderr: "pipe", stdout: "pipe", signal: deadline });
            const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
            return !output.includes("yt-dlp is up to date");
        },
    };
}

/**
 * Runs the yt-dlp metadata dump for a video URL and returns its stdout (the info JSON).
 *
 * On failure:
 * - When proxied, retries up to `proxyRetries` times while the failure stays
 *   proxy-retryable (see {@link isProxyRetryableYtDlpError}). Each retry spawns a new
 *   process, so a rotating proxy hands out a fresh exit IP. Retrying stops early once a
 *   failure is of a different kind (e.g. an extractor error or a private video).
 * - If the final failure is not proxy-retryable, it may stem from an outdated extractor,
 *   so `yt-dlp --update` is attempted and the dump retried once if a new version was installed.
 *
 * @param url - The video URL (used for logging)
 * @param logger - Logger instance
 * @param runner - yt-dlp process operations
 * @param deadline - Overall tool call deadline; once aborted, no further attempts are made
 * @param proxied - Whether yt-dlp is running through a (rotating) proxy
 * @param proxyRetries - Maximum number of proxy rotation retries
 * @throws {ToolError} When all attempts fail or the deadline is exceeded
 */
export async function fetchMetadataWithRetries(
    url: string,
    logger: Logger,
    runner: YtDlpMetadataRunner,
    deadline: AbortSignal,
    proxied: boolean,
    proxyRetries: number,
): Promise<string> {
    throwIfDeadlineExceeded(deadline);
    let result = await runner.runMetadata();
    if (result.exitCode === 0) return result.stdout;
    throwIfDeadlineExceeded(deadline);

    logger.warn({ url, proxied, stderr: result.stderr.trim() }, "yt-dlp metadata fetch failed");

    if (proxied) {
        for (let attempt = 1; attempt <= proxyRetries && isProxyRetryableYtDlpError(result.stderr); attempt++) {
            logger.info({ url, attempt, proxyRetries }, "Transient yt-dlp failure, retrying with rotated proxy IP");
            result = await runner.runMetadata();
            if (result.exitCode === 0) return result.stdout;
            throwIfDeadlineExceeded(deadline);
            logger.debug({ url, attempt, stderr: result.stderr.trim() }, "yt-dlp metadata retry failed");
        }
    }

    if (!isProxyRetryableYtDlpError(result.stderr)) {
        logger.info({ url }, "yt-dlp failure is not IP/network related, attempting yt-dlp update");
        const updated = await runner.update();
        throwIfDeadlineExceeded(deadline);
        if (updated) {
            logger.info({ url }, "yt-dlp was updated, retrying metadata fetch");
            result = await runner.runMetadata();
            if (result.exitCode === 0) return result.stdout;
            throwIfDeadlineExceeded(deadline);
        } else {
            logger.debug({ url }, "yt-dlp is already up to date");
        }
    }

    throw new ToolError(`yt-dlp failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

/** Performs a single caption HTTP request. */
export type CaptionRequester = (captionUrl: string) => Promise<Response>;

/**
 * Fetches a caption URL, retrying up to `retries` extra times when the request
 * throws (proxy timeouts, connection resets) or returns 429. With a rotating proxy
 * each attempt opens a new connection, and so gets a fresh exit IP.
 *
 * @param captionUrl - The caption track URL
 * @param request - Performs one HTTP request (carries the proxy and timeout)
 * @param retries - Maximum number of retries after the first attempt
 * @param logger - Logger instance
 * @param deadline - Overall tool call deadline; once aborted, no further attempts are made
 * @returns The final response, or null if the last attempt threw
 * @throws {ToolError} When the deadline is exceeded
 */
export async function fetchCaptionWithRetries(
    captionUrl: string,
    request: CaptionRequester,
    retries: number,
    logger: Logger,
    deadline: AbortSignal,
): Promise<Response | null> {
    let response: Response | null = null;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        throwIfDeadlineExceeded(deadline);
        const willRetry = attempt <= retries;
        try {
            response = await request(captionUrl);
        } catch (err) {
            // A request aborted by the deadline is a timeout, not a retryable failure
            throwIfDeadlineExceeded(deadline);
            response = null;
            const error = err instanceof Error ? err.message : String(err);
            logger.debug({ captionUrl, attempt, retries, willRetry, error }, "Caption fetch threw");
            continue;
        }

        if (response.status !== 429) return response;
        logger.debug({ captionUrl, attempt, retries, willRetry }, "Caption fetch returned 429");
    }
    return response;
}

// TODO: config var
const DEFAULT_CAPTIONS_TIMEOUT_MS = 15_000;
const PROXY_CAPTIONS_TIMEOUT_MS = 30_000;

/**
 * Runs yt-dlp -J for a single video URL to get metadata, selects the best
 * available caption URL by priority, fetches it (retrying on 429s and request
 * errors when proxied), and returns
 * the raw caption content formatted with the video URL as a heading.
 *
 * @param url - The video URL to process
 * @param logger - Logger instance for progress tracking
 * @param deadline - Overall tool call deadline; aborts processes and requests when it fires
 * @param proxy - Optional HTTP/HTTPS proxy URL
 * @param proxyRetries - Number of proxy rotation retries
 */
async function extractCaptions(
    url: string,
    logger: Logger,
    deadline: AbortSignal,
    proxy: string | undefined,
    proxyRetries: number,
): Promise<VideoCaptionsResult> {
    logger.debug({ url }, "Fetching video metadata via yt-dlp -J");

    const stdout = await fetchMetadataWithRetries(
        url,
        logger,
        createSpawnYtDlpRunner(url, deadline, proxy),
        deadline,
        proxy !== undefined,
        proxyRetries,
    );

    let raw: unknown;
    try {
        raw = JSON.parse(stdout);
    } catch {
        throw new ToolError("Failed to parse yt-dlp JSON output");
    }

    const parsed = InfoJsonSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ToolError(`Unexpected yt-dlp info JSON structure: ${parsed.error.message}`);
    }
    const info = parsed.data;

    const captionUrls = selectCaptionUrls(info);

    if (captionUrls.length === 0) {
        // Distinguish a video without any captions from one whose tracks were all filtered
        // out (streaming-only or auto-translated), to spot overly strict filtering in logs
        const trackCount = countCaptionTracks(info);
        logger.debug({ url, trackCount }, "No caption URLs selected");
        throw new NoCaptionsError(
            trackCount === 0
                ? "This video has no captions or subtitles available"
                : "This video has no captions in a format that can be retrieved",
            info.title ?? null,
            info.channel ?? info.uploader ?? null,
        );
    }

    logger.debug({ url, count: captionUrls.length }, "Trying caption URLs in priority order");

    const timeout = proxy ? PROXY_CAPTIONS_TIMEOUT_MS : DEFAULT_CAPTIONS_TIMEOUT_MS;
    // Abort on whichever fires first: the per-request timeout or the overall deadline
    const request: CaptionRequester = (captionUrl) =>
        fetch(captionUrl, { signal: AbortSignal.any([AbortSignal.timeout(timeout), deadline]), proxy });
    // Retrying only helps when a rotating proxy can hand out a fresh IP
    const retries = proxy ? proxyRetries : 0;
    // Try each URL in priority order, falling through to the next URL on persistent failure
    for (const captionUrl of captionUrls) {
        const response = await fetchCaptionWithRetries(captionUrl, request, retries, logger, deadline);

        if (!response?.ok) {
            logger.debug({ captionUrl, status: response?.status }, "Caption fetch non-OK, trying next URL");
            continue;
        }

        const videoCaptions = await response.text();
        logger.debug({ url, captionUrl }, "Successfully fetched captions");
        return {
            url,
            videoCaptions,
            ...(info.title && { title: info.title }),
            ...((info.channel ?? info.uploader) ? { author: info.channel ?? info.uploader } : {}),
        };
    }

    throw new ToolError(`All ${captionUrls.length} caption URLs failed`);
}

export type GetVideoCaptionsTool = Awaited<ReturnType<typeof createGetVideoCaptionsTool>>;
