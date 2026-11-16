/**
 * Turns a raw caption file into a compact, token-efficient transcript for the LLM:
 * one line per sentence, each starting with the time the sentence begins at.
 *
 *   0:00 This might be the most ambitious long shot precision experiment that I've ever seen.
 *   0:06 Scientists have put one atomic clock down in Boulder, Colorado ...
 *   1:02:07 ...
 *
 * Markup, cue end times and word-level timing are dropped, which cuts a raw srt file
 * to roughly a quarter of its tokens and word-level formats to a few percent.
 */

import { extractCaptionUnits, isRawUnit, isSupportedCaptionFormat } from "./captionExtractors.ts";
import { type CaptionLine, groupSentences } from "./sentenceGrouping.ts";

/**
 * Highest share of a file's units that may fail to parse. Up to this share the failed
 * units are included verbatim for the LLM to interpret; above it the extractor is
 * considered broken for this file, as including that much raw markup would cost more
 * tokens than the formatting saves.
 */
export const MAX_RAW_UNIT_RATIO = 0.05;

/** Result of formatting a caption file. */
export type CaptionFormatResult =
    | {
          status: "ok";
          /** The formatted transcript. */
          text: string;
          /** Number of cues parsed from the file. */
          cueCount: number;
          /** Number of units that failed to parse and were included verbatim. */
          rawUnitCount: number;
          /** False when punctuation was too sparse for sentence grouping, so cues were kept as lines. */
          sentenceGrouped: boolean;
      }
    /** The file was read fine but holds no cue with visible text. */
    | { status: "empty" }
    /** The file could not be parsed, entirely or beyond {@link MAX_RAW_UNIT_RATIO}. */
    | { status: "failed"; reason: string };

/**
 * Formats a time as `M:SS`, or `H:MM:SS` from one hour on. Sub-second information is
 * truncated rather than rounded, so a timestamp never points past the text it labels.
 */
export function formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Renders caption lines as text: `<timestamp> <text>` for timed lines, raw units verbatim. */
export function renderCaptionLines(lines: CaptionLine[]): string {
    return lines
        .map((line) => (isRawUnit(line) ? line.raw : `${formatTimestamp(line.startMs)} ${line.text}`))
        .join("\n");
}

/**
 * Formats a raw caption file as a compact transcript with one timestamped line per sentence.
 *
 * Never throws: a file that can't be parsed yields a `failed` result, and one without
 * any visible text an `empty` result, so the caller can decide between trying another
 * format and giving up.
 *
 * @param format - Caption format, i.e. the `ext` yt-dlp reports (srt, vtt, ttml, srv1, srv2, srv3, json3)
 * @param content - Raw caption file content
 */
export function formatCaptions(format: string, content: string): CaptionFormatResult {
    if (!isSupportedCaptionFormat(format)) {
        return { status: "failed", reason: `unsupported caption format "${format}"` };
    }

    let units: ReturnType<typeof extractCaptionUnits>;
    try {
        units = extractCaptionUnits(format, content);
    } catch (err) {
        return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }

    const rawUnitCount = units.filter(isRawUnit).length;
    const cueCount = units.length - rawUnitCount;
    if (units.length === 0) return { status: "empty" };
    if (rawUnitCount / units.length > MAX_RAW_UNIT_RATIO) {
        return { status: "failed", reason: `${rawUnitCount} of ${units.length} units could not be parsed` };
    }

    const grouping = groupSentences(units);
    return {
        status: "ok",
        text: renderCaptionLines(grouping.lines),
        cueCount,
        rawUnitCount,
        sentenceGrouped: !grouping.usedFallback,
    };
}
