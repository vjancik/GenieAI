import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { Logger } from "../../../application/types/Logger.ts";
import { ToolError } from "../../../domain/errors/AppError.ts";

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
    subtitles: z.record(z.string(), z.array(CaptionEntrySchema)).default({}),
    automatic_captions: z.record(z.string(), z.array(CaptionEntrySchema)).default({}),
});

/** Shape of a single caption track entry from yt-dlp's info JSON. */
export type YtDlpCaptionEntry = z.infer<typeof CaptionEntrySchema>;

/** Relevant subset of the yt-dlp --dump-single-json output. */
export type YtDlpInfoJson = z.infer<typeof InfoJsonSchema>;

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
    const proc = Bun.spawn(["yt-dlp", "--version"], { stderr: "pipe", stdout: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) {
        throw new ToolError("yt-dlp is not available in PATH and is required for video transcription");
    }
}

/**
 * Creates a LangChain tool that extracts transcriptions from video URLs using yt-dlp.
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
 * @param logger - Injectable logger for testability
 * @param proxy - Optional HTTP/HTTPS proxy URL (from YT_DLP_HTTP_PROXY)
 * @param proxyRetries - Number of proxy rotation retries for bot-detection and 429 errors
 */
export async function createGetVideoTranscriptionTool(logger: Logger, proxy?: string, proxyRetries = 5) {
    if (proxy !== undefined) {
        const scheme = new URL(proxy).protocol;
        if (scheme !== "http:" && scheme !== "https:") {
            throw new ToolError(`YT_DLP_HTTP_PROXY must use http:// or https://, got: ${scheme}`);
        }
    }
    await verifyYtDlp();
    return tool(
        async ({ urls }) => {
            // Deduplicate URLs to avoid redundant yt-dlp invocations
            const unique = [...new Set(urls)];
            logger.debug({ urls: unique }, "Extracting video transcriptions");

            const results = await Promise.allSettled(
                unique.map((url) => extractTranscription(url, logger, proxy, proxyRetries)),
            );

            return results
                .map((result, i) => {
                    if (result.status === "fulfilled") {
                        return result.value;
                    }
                    const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
                    logger.warn({ url: unique[i], error: err.message }, "Failed to extract transcription");
                    return `## ${unique[i]}\n\nError: ${err.message}`;
                })
                .join("\n\n---\n\n");
        },
        {
            name: "get_video_transcription",
            description:
                "Extract transcriptions/subtitles from video URLs (YouTube, social media, etc.). " +
                "Use this when the user provides URLs pointing to video content they want summarized or analyzed.",
            schema: z.object({
                urls: z.array(z.url()).min(1).describe("Video URLs to transcribe"),
            }),
        },
    );
}

/**
 * Runs `yt-dlp --flat-playlist -J` for the given URL and returns stdout.
 * On non-zero exit, attempts `yt-dlp --update`; if an update was applied
 * (output does not contain "yt-dlp is up to date"), retries the metadata
 * command once before throwing.
 */
const BOT_DETECTION_MSG = "Sign in to confirm you're not a bot.";

/**
 * Runs `yt-dlp --flat-playlist -J` for the given URL and returns stdout.
 *
 * On non-zero exit:
 * - If stderr contains the bot-detection message and a proxy is set, retries
 *   up to `proxyRetries` times (rotating proxy IPs on each attempt).
 * - Otherwise, attempts `yt-dlp --update`; if an update was applied retries once.
 */
async function fetchYtDlpMetadata(url: string, logger: Logger, proxy?: string, proxyRetries = 5): Promise<string> {
    const proxyArgs = proxy ? ["--proxy", proxy] : [];
    const runMeta = async () => {
        // --flat-playlist: fail fast on playlists rather than fetching all entries
        const proc = Bun.spawn(["yt-dlp", "--no-warnings", "--flat-playlist", ...proxyArgs, "-J", url], {
            stderr: "pipe",
            stdout: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { stdout, exitCode: proc.exitCode, stderr };
    };

    let result = await runMeta();

    if (result.exitCode !== 0) {
        logger.warn(
            { url, proxied: proxy !== undefined, stderr: result.stderr.trim() },
            "yt-dlp metadata fetch failed, attempting update",
        );

        // Bot detection with a proxy: retry to rotate the proxy IP
        if (proxy && result.stderr.includes(BOT_DETECTION_MSG)) {
            for (let attempt = 1; attempt <= proxyRetries && result.exitCode !== 0; attempt++) {
                logger.info({ url, attempt, proxyRetries }, "Bot detection hit, retrying with rotated proxy IP");
                result = await runMeta();
            }
        } else {
            // Non-bot failure: try updating yt-dlp, then retry once if updated
            const updateProc = Bun.spawn(["yt-dlp", "--update"], { stderr: "pipe", stdout: "pipe" });
            const [updateOutput] = await Promise.all([new Response(updateProc.stdout).text(), updateProc.exited]);

            if (!updateOutput.includes("yt-dlp is up to date")) {
                logger.info({ url }, "yt-dlp was updated, retrying metadata fetch");
                result = await runMeta();
            }
        }

        if (result.exitCode !== 0) {
            throw new ToolError(`yt-dlp failed (exit ${result.exitCode}) for URL: ${url}: ${result.stderr.trim()}`);
        }
    }

    return result.stdout;
}

/**
 * Runs yt-dlp -J for a single video URL to get metadata, selects the best
 * available caption URL by priority, fetches it (retrying on 429), and returns
 * the raw caption content formatted with the video URL as a heading.
 *
 * @param url - The video URL to process
 * @param logger - Logger instance for progress tracking
 */
async function extractTranscription(url: string, logger: Logger, proxy?: string, proxyRetries = 5): Promise<string> {
    logger.debug({ url }, "Fetching video metadata via yt-dlp -J");

    const stdout = await fetchYtDlpMetadata(url, logger, proxy, proxyRetries);

    let raw: unknown;
    try {
        raw = JSON.parse(stdout);
    } catch {
        throw new ToolError(`Failed to parse yt-dlp JSON output for URL: ${url}`);
    }

    const parsed = InfoJsonSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ToolError(`Unexpected yt-dlp info JSON structure for URL: ${url}: ${parsed.error.message}`);
    }
    const info = parsed.data;

    const captionUrls = selectCaptionUrls(info);

    if (captionUrls.length === 0) {
        throw new ToolError(`No caption tracks found for URL: ${url}`);
    }

    logger.debug({ url, count: captionUrls.length }, "Trying caption URLs in priority order");

    // Try each URL in priority order; on 429 retry up to proxyRetries times to
    // rotate the proxy IP, then fall through to the next URL on persistent failure
    for (const captionUrl of captionUrls) {
        let response: Response | undefined;
        for (let attempt = 0; attempt <= (proxy ? proxyRetries : 0); attempt++) {
            try {
                response = await fetch(captionUrl, { signal: AbortSignal.timeout(30_000), proxy });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug({ captionUrl, error: msg }, "Caption fetch threw, trying next URL");
                break;
            }

            if (response.status !== 429) break;
            logger.debug({ captionUrl, attempt, proxyRetries }, "Caption fetch 429, retrying with rotated proxy IP");
        }

        if (!response?.ok) {
            logger.debug({ captionUrl, status: response?.status }, "Caption fetch non-OK, trying next URL");
            continue;
        }

        const content = await response.text();
        logger.debug({ url, captionUrl }, "Successfully fetched captions");
        return `## ${url}\n\n${content}`;
    }

    throw new ToolError(`All ${captionUrls.length} caption URLs failed for: ${url}`);
}

export type GetVideoTranscriptionTool = Awaited<ReturnType<typeof createGetVideoTranscriptionTool>>;
