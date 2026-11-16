/**
 * Downloads every available English caption track (uploader-provided and automatic,
 * in all formats) for one or more videos into ./data, mimicking the way getVideoCaptionsTool
 * retrieves captions: `yt-dlp -J` for the metadata, then plain HTTP fetches of the
 * caption URLs it lists.
 *
 * Run via: bunx cross-env AGENT=1 bun scripts/dev/yt-captions-processing/download-captions.ts [videoUrl...]
 *
 * Requests are sequential and spaced out, and 429s are retried with exponential
 * backoff, to stay clear of YouTube's caption rate limits. Already downloaded
 * tracks are skipped, so the script can be rerun safely.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { file, sleep, spawn, write } from "bun";
import { z } from "zod";

const DEFAULT_VIDEO_URLS = [
    "https://www.youtube.com/watch?v=SxFJ5QGNxwo",
    "https://www.youtube.com/watch?v=eyZEqSPeMwg",
    "https://www.youtube.com/watch?v=KfODG5REyss",
];
const DATA_DIR = join(import.meta.dir, "data");
/** Suffix of the per-video yt-dlp metadata dump stored next to the captions. */
const INFO_SUFFIX = ".info.json";

/** Pause between two caption requests. */
const REQUEST_SPACING_MS = 2_500;
/** First backoff delay after a 429, doubled on each further attempt. */
const BACKOFF_BASE_MS = 15_000;
const MAX_ATTEMPTS = 5;

const CaptionEntrySchema = z.object({
    ext: z.string(),
    url: z.string(),
    name: z.string().optional(),
    protocol: z.string().optional(),
});
const CaptionMapSchema = z.record(z.string(), z.array(CaptionEntrySchema)).default({});
const InfoJsonSchema = z.object({
    id: z.string(),
    title: z.string().optional(),
    subtitles: CaptionMapSchema,
    automatic_captions: CaptionMapSchema,
});

type CaptionMap = z.infer<typeof CaptionMapSchema>;

interface Track {
    /** "manual" = uploader provided, "auto" = automatic speech recognition. */
    kind: "manual" | "auto";
    lang: string;
    ext: string;
    url: string;
}

/** Runs `yt-dlp -J` with the same flags as the captions tool and returns the raw info JSON. */
async function fetchInfoJson(videoUrl: string): Promise<string> {
    const proc = spawn(["yt-dlp", "--no-warnings", "--flat-playlist", "--socket-timeout", "10", "-J", videoUrl], {
        stderr: "pipe",
        stdout: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (proc.exitCode !== 0) {
        throw new Error(`yt-dlp failed (exit ${proc.exitCode}): ${stderr.trim()}`);
    }
    return stdout;
}

/** Whether a language code is English ("en", "en-US", "en-orig", ...). */
function isEnglish(lang: string): boolean {
    return lang === "en" || lang.startsWith("en-") || lang.startsWith("en_");
}

/**
 * Collects the directly fetchable English tracks of one caption map.
 * `<lang>-orig` tracks are dropped when `<lang>` exists too, as YouTube serves
 * identical content for both.
 */
function collectTracks(map: CaptionMap, kind: Track["kind"]): Track[] {
    return Object.entries(map)
        .filter(([lang]) => isEnglish(lang))
        .filter(([lang]) => !(lang.endsWith("-orig") && lang.slice(0, -"-orig".length) in map))
        .flatMap(([lang, entries]) =>
            entries
                // HLS/DASH streaming entries can't be fetched with a single HTTP request
                .filter((entry) => !entry.protocol || entry.protocol === "https" || entry.protocol === "http")
                .map((entry) => ({ kind, lang, ext: entry.ext, url: entry.url })),
        );
}

/** Reads a Retry-After header given in seconds, if present. */
function retryAfterMs(response: Response): number | null {
    const seconds = Number(response.headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Fetches one caption track, backing off exponentially on 429s and 5xx responses. */
async function fetchTrack(track: Track): Promise<string> {
    for (let attempt = 1; ; attempt++) {
        const response = await fetch(track.url, { signal: AbortSignal.timeout(30_000) });
        if (response.ok) return response.text();

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
            throw new Error(`HTTP ${response.status} after ${attempt} attempt(s)`);
        }
        const delay = retryAfterMs(response) ?? BACKOFF_BASE_MS * 2 ** (attempt - 1);
        console.warn(`  HTTP ${response.status}, backing off ${delay / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await sleep(delay);
    }
}

/**
 * Downloads all English caption tracks of one video.
 *
 * @returns The file names of the tracks that could not be downloaded
 */
async function downloadVideoCaptions(videoUrl: string): Promise<string[]> {
    console.log(`\nFetching metadata for ${videoUrl}`);
    const infoJson = await fetchInfoJson(videoUrl);
    const info = InfoJsonSchema.parse(JSON.parse(infoJson));
    await write(join(DATA_DIR, `${info.id}${INFO_SUFFIX}`), infoJson);

    const tracks = [...collectTracks(info.subtitles, "manual"), ...collectTracks(info.automatic_captions, "auto")];
    console.log(`"${info.title ?? info.id}": ${tracks.length} English caption track(s)`);

    const failures: string[] = [];
    for (const track of tracks) {
        const fileName = `${info.id}.${track.kind}.${track.lang}.${track.ext}`;
        const target = join(DATA_DIR, fileName);
        if (await file(target).exists()) {
            console.log(`skip  ${fileName} (already downloaded)`);
            continue;
        }
        try {
            const content = await fetchTrack(track);
            await write(target, content);
            console.log(`saved ${fileName} (${content.length.toLocaleString("en-US")} chars)`);
        } catch (err) {
            failures.push(fileName);
            console.error(`FAIL  ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await sleep(REQUEST_SPACING_MS);
    }
    return failures;
}

const videoUrls = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_VIDEO_URLS;
await mkdir(DATA_DIR, { recursive: true });

const failures: string[] = [];
for (const videoUrl of videoUrls) {
    failures.push(...(await downloadVideoCaptions(videoUrl)));
}

if (failures.length > 0) {
    console.error(`\n${failures.length} track(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll tracks downloaded.");
