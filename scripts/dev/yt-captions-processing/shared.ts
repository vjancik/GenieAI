/**
 * Helpers shared by the caption token experiment scripts: locating the downloaded
 * caption files, counting Gemini tokens, and plain-text report rendering.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { file, hash, sleep, write } from "bun";
import { z } from "zod";

/** The general agent model of config.default.yaml, which is the one consuming the captions. */
export const DEFAULT_MODEL = "gemini-3.8-flash";
export const DATA_DIR = join(import.meta.dir, "data");
export const OUTPUT_DIR = join(import.meta.dir, "outputs");

/** Suffix of the per-video yt-dlp metadata dump stored next to the captions. */
const INFO_SUFFIX = ".info.json";
/** Caption file names, as written by download-captions.ts: <videoId>.<manual|auto>.<language>.<format> */
const CAPTION_FILE_PATTERN = /^(?<videoId>[^.]+)\.(?<kind>manual|auto)\.(?<lang>[^.]+)\.(?<format>[^.]+)$/;
/** Pause after each countTokens request, to stay well inside the free tier quota. */
const REQUEST_SPACING_MS = 1_000;
const TOKEN_CACHE_FILE = join(OUTPUT_DIR, "token_cache.json");

const VideoInfoSchema = z.object({
    id: z.string(),
    title: z.string().optional(),
    channel: z.string().optional(),
    duration: z.number().optional(),
    duration_string: z.string().optional(),
    webpage_url: z.string().optional(),
});
const TokenCacheSchema = z.record(z.string(), z.number());

/** The yt-dlp metadata fields used in reports. */
export type VideoInfo = z.infer<typeof VideoInfoSchema>;

/** A downloaded caption file, identified by the components of its file name. */
export interface CaptionFile {
    name: string;
    path: string;
    videoId: string;
    /** "manual" = uploader provided, "auto" = automatic speech recognition. */
    kind: string;
    lang: string;
    format: string;
}

/** Counts the tokens of a text. */
export type TokenCounter = (content: string) => Promise<number>;

/** Lists the caption files in the data directory, sorted by name. */
export async function listCaptionFiles(): Promise<CaptionFile[]> {
    const captionFiles: CaptionFile[] = [];
    for (const name of (await readdir(DATA_DIR)).sort()) {
        const { videoId, kind, lang, format } = CAPTION_FILE_PATTERN.exec(name)?.groups ?? {};
        if (!videoId || !kind || !lang || !format) continue;
        captionFiles.push({ name, path: join(DATA_DIR, name), videoId, kind, lang, format });
    }
    if (captionFiles.length === 0) {
        throw new Error(`No caption files in ${DATA_DIR}, run download-captions.ts first`);
    }
    return captionFiles;
}

/** Loads the metadata of every downloaded video, sorted by file name. */
export async function loadVideoInfos(): Promise<VideoInfo[]> {
    const names = (await readdir(DATA_DIR)).filter((name) => name.endsWith(INFO_SUFFIX)).sort();
    return Promise.all(names.map(async (name) => VideoInfoSchema.parse(await file(join(DATA_DIR, name)).json())));
}

/**
 * Creates a token counter backed by the @google/genai countTokens API, using the first
 * key of GOOGLE_FREE_API_KEYS. Counts are cached on disk by model and content hash, so
 * identical contents (and reruns) cost no further requests.
 *
 * @param model - Model whose tokenizer is used
 * @throws {Error} When GOOGLE_FREE_API_KEYS is not set
 */
export async function createTokenCounter(model: string): Promise<TokenCounter> {
    const apiKey = process.env.GOOGLE_FREE_API_KEYS?.split(",")[0]?.trim();
    if (!apiKey) {
        throw new Error("GOOGLE_FREE_API_KEYS is not set");
    }
    const genai = new GoogleGenAI({ apiKey });

    await mkdir(OUTPUT_DIR, { recursive: true });
    const cacheFile = file(TOKEN_CACHE_FILE);
    const cache = (await cacheFile.exists()) ? TokenCacheSchema.parse(await cacheFile.json()) : {};

    return async (content) => {
        const key = `${model}:${hash(content).toString(36)}:${content.length}`;
        const cached = cache[key];
        if (cached !== undefined) return cached;

        const response = await genai.models.countTokens({ model, contents: content });
        if (response.totalTokens === undefined) {
            throw new Error("countTokens returned no total");
        }
        cache[key] = response.totalTokens;
        await write(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 4));
        await sleep(REQUEST_SPACING_MS);
        return response.totalTokens;
    };
}

/** Formats an integer with thousands separators. */
export function formatInt(value: number): string {
    return value.toLocaleString("en-US");
}

/** Formats how much smaller `value` is than `baseline`, e.g. "-42.0%". */
export function formatSaving(value: number, baseline: number): string {
    const change = (value / baseline - 1) * 100;
    return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

/** Renders rows as a plain-text table, left-aligning the first column and right-aligning the rest. */
export function renderTable(header: string[], rows: string[][]): string {
    const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i]?.length ?? 0)));
    const renderRow = (row: string[]) =>
        row
            .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
            .join("  ")
            .trimEnd();
    const separator = widths.map((width) => "-".repeat(width)).join("  ");
    return [renderRow(header), separator, ...rows.map(renderRow)].join("\n");
}

/** Renders the title, channel, duration and URL lines of a video. */
export function renderVideoHeader(info: VideoInfo): string {
    return [
        `Video:    ${info.title ?? info.id}`,
        `Channel:  ${info.channel ?? "unknown"}`,
        `Duration: ${info.duration_string ?? "unknown"}`,
        `URL:      ${info.webpage_url ?? "unknown"}`,
    ].join("\n");
}
