/**
 * Counts the Gemini tokens of every raw (unprocessed) caption file in ./data using the
 * @google/genai countTokens API, and writes a human readable report to
 * ./outputs/token_stats_unprocessed.txt.
 *
 * Run via: bunx cross-env AGENT=1 bun scripts/dev/yt-captions-processing/count-tokens.ts [model]
 *
 * The report has one table per video, followed by a cross-video comparison of how the
 * caption formats rank by token count.
 */

import { join } from "node:path";
import { file, write } from "bun";
import {
    createTokenCounter,
    DEFAULT_MODEL,
    formatInt,
    listCaptionFiles,
    loadVideoInfos,
    OUTPUT_DIR,
    renderTable,
    renderVideoHeader,
    type VideoInfo,
} from "./shared.ts";

const OUTPUT_FILE = join(OUTPUT_DIR, "token_stats_unprocessed.txt");

interface TrackStats {
    videoId: string;
    /** "manual" = uploader provided, "auto" = automatic speech recognition. */
    kind: string;
    lang: string;
    format: string;
    bytes: number;
    chars: number;
    tokens: number;
}

/** Short label of a track within its video, e.g. "auto en srt". */
function trackLabel(track: TrackStats): string {
    return `${track.kind} ${track.lang} ${track.format}`;
}

/** Sorts tracks from cheapest to most expensive without mutating the input. */
function byTokens(tracks: TrackStats[]): TrackStats[] {
    return [...tracks].sort((a, b) => a.tokens - b.tokens);
}

/** Renders the header and the token table (cheapest first) of one video. */
function renderVideoSection(info: VideoInfo, tracks: TrackStats[]): string {
    const sorted = byTokens(tracks);
    const smallest = sorted[0]?.tokens ?? 1;
    const minutes = info.duration === undefined ? null : info.duration / 60;
    const rows = sorted.map((track, i) => [
        trackLabel(track),
        String(i + 1),
        formatInt(track.bytes),
        formatInt(track.chars),
        formatInt(track.tokens),
        (track.chars / track.tokens).toFixed(2),
        minutes === null ? "n/a" : formatInt(Math.round(track.tokens / minutes)),
        `${(track.tokens / smallest).toFixed(2)}x`,
    ]);
    return [
        renderVideoHeader(info),
        "",
        renderTable(["Track", "Rank", "Bytes", "Chars", "Tokens", "Chars/token", "Tokens/min", "vs smallest"], rows),
    ].join("\n");
}

/**
 * Renders, per caption kind, how the formats rank by token count in each video,
 * and whether that order is the same in all videos having tracks of that kind.
 */
function renderFormatComparison(videos: VideoInfo[], tracks: TrackStats[]): string {
    const sections: string[] = [];
    for (const kind of ["auto", "manual"]) {
        // Format order (cheapest first) per video, for videos having tracks of this kind
        const orders = new Map<string, string[]>();
        for (const video of videos) {
            const ofKind = byTokens(tracks.filter((track) => track.videoId === video.id && track.kind === kind));
            if (ofKind.length > 0) orders.set(video.id, [...new Set(ofKind.map((track) => track.format))]);
        }
        if (orders.size === 0) continue;

        const videoIds = [...orders.keys()];
        const firstOrder = orders.get(videoIds[0] ?? "") ?? [];
        const rows = firstOrder.map((format) => [
            format,
            ...videoIds.flatMap((videoId) => {
                const track = tracks.find(
                    (candidate) =>
                        candidate.videoId === videoId && candidate.kind === kind && candidate.format === format,
                );
                const rank = (orders.get(videoId) ?? []).indexOf(format) + 1;
                return [track ? formatInt(track.tokens) : "n/a", rank > 0 ? `#${rank}` : "n/a"];
            }),
        ]);
        const sameOrder = [...orders.values()].every((order) => order.join() === firstOrder.join());
        const verdict =
            orders.size < 2
                ? "Only one video has tracks of this kind, nothing to compare."
                : `Same format order in all ${orders.size} videos: ${sameOrder ? "YES" : "NO"}`;

        sections.push(
            [
                `${kind === "auto" ? "Automatic" : "Uploader-provided (manual)"} captions, formats by token count`,
                "",
                renderTable(["Format", ...videoIds.flatMap((videoId) => [`${videoId} tokens`, "rank"])], rows),
                "",
                verdict,
                ...[...orders].map(([videoId, order]) => `  ${videoId}: ${order.join(" < ")}`),
            ].join("\n"),
        );
    }
    return sections.join("\n\n");
}

const model = process.argv[2] ?? DEFAULT_MODEL;
const countTokens = await createTokenCounter(model);
const videos = await loadVideoInfos();

const tracks: TrackStats[] = [];
for (const { name, path, videoId, kind, lang, format } of await listCaptionFiles()) {
    const captionFile = file(path);
    const content = await captionFile.text();
    const tokens = await countTokens(content);
    console.log(`${name}: ${formatInt(tokens)}`);
    tracks.push({ videoId, kind, lang, format, bytes: captionFile.size, chars: content.length, tokens });
}

const divider = "=".repeat(78);
const report = [
    "Token stats of unprocessed caption files",
    divider,
    "",
    `Model:     ${model} (@google/genai countTokens)`,
    `Generated: ${new Date().toISOString()}`,
    "",
    'Tracks are "<kind> <language> <format>": "manual" = uploader provided,',
    '"auto" = automatic speech recognition. The whole raw file content is counted as-is.',
    '"Rank" and "vs smallest" are relative to the cheapest track of the same video.',
    "",
    ...videos.flatMap((video) => [
        divider,
        renderVideoSection(
            video,
            tracks.filter((track) => track.videoId === video.id),
        ),
        "",
    ]),
    divider,
    "Cross-video comparison",
    "",
    renderFormatComparison(videos, tracks),
    "",
].join("\n");

await write(OUTPUT_FILE, report);
console.log(`\nWrote ${OUTPUT_FILE}`);
