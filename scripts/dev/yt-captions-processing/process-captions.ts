/**
 * Runs both caption pre-processing pipelines over every caption file in ./data and
 * compares their Gemini token counts against the raw files:
 *
 *   1. unified:   extraction into one `<timestamp> <text>` line per cue
 *   2. sentences: the same, regrouped into one line per sentence
 *
 * Run via: bunx cross-env AGENT=1 bun scripts/dev/yt-captions-processing/process-captions.ts [model]
 *
 * Writes the processed captions to ./outputs/unified and ./outputs/sentences, and a
 * report with token counts, transformation durations and cross-format consistency
 * checks to ./outputs/token_stats_processed.txt.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { file, write } from "bun";
import {
    type CaptionUnit,
    extractCaptionUnits,
    isRawUnit,
    type RawUnit,
    type TimedText,
} from "../../../src/application/formatters/captions/captionExtractors.ts";
import { formatTimestamp, renderCaptionLines } from "../../../src/application/formatters/captions/formatCaptions.ts";
import { countWords, groupSentences } from "../../../src/application/formatters/captions/sentenceGrouping.ts";
import {
    type CaptionFile,
    createTokenCounter,
    DEFAULT_MODEL,
    formatInt,
    formatSaving,
    listCaptionFiles,
    loadVideoInfos,
    OUTPUT_DIR,
    renderTable,
    renderVideoHeader,
} from "./shared.ts";

const OUTPUT_FILE = join(OUTPUT_DIR, "token_stats_processed.txt");
/** Format every other format is compared against: line-level, and the cheapest raw one. */
const REFERENCE_FORMAT = "srv1";
/** Format with exact word-level timing, used to measure the timestamp drift of line-level formats. */
const WORD_LEVEL_FORMAT = "json3";

interface TrackResult {
    captionFile: CaptionFile;
    rawTokens: number;
    /** All extracted units, including the ones that failed to parse. */
    units: CaptionUnit[];
    /** The successfully parsed cues. */
    cues: TimedText[];
    /** Number of units that failed to parse and were kept verbatim. */
    rawUnitCount: number;
    unifiedTokens: number;
    /** Duration of extraction plus rendering, single cold-ish run. */
    extractMs: number;
    sentences: TimedText[];
    usedFallback: boolean;
    sentenceTokens: number;
    /** Duration of sentence grouping plus rendering, single cold-ish run. */
    groupMs: number;
}

/** Narrows a unit or line to one that was parsed, i.e. carries a start time. */
function isTimedLine<T extends TimedText>(line: T | RawUnit): line is T {
    return !isRawUnit(line);
}

/** Short label of a track within its video, e.g. "auto en srt". */
function trackLabel(captionFile: CaptionFile): string {
    return `${captionFile.kind} ${captionFile.lang} ${captionFile.format}`;
}

/** Describes how the timed lines of a track differ from those of a reference track. */
function describeDifference(lines: TimedText[], reference: TimedText[]): string {
    if (lines.length !== reference.length) {
        return `DIFFERENT line count (${formatInt(lines.length)} vs ${formatInt(reference.length)})`;
    }
    let textDiffs = 0;
    let timestampDiffs = 0;
    let driftSum = 0;
    let maxDrift = 0;
    let firstTextDiff: string | null = null;
    for (const [i, line] of lines.entries()) {
        const other = reference[i];
        if (!other) continue;
        if (line.text !== other.text) {
            textDiffs++;
            firstTextDiff ??= `line ${i + 1}: "${line.text}" vs "${other.text}"`;
        }
        if (formatTimestamp(line.startMs) !== formatTimestamp(other.startMs)) timestampDiffs++;
        const drift = Math.abs(line.startMs - other.startMs) / 1000;
        driftSum += drift;
        maxDrift = Math.max(maxDrift, drift);
    }
    if (textDiffs === 0 && timestampDiffs === 0) return "identical";
    const details = [
        `text differs on ${formatInt(textDiffs)} of ${formatInt(lines.length)} lines`,
        `timestamp differs on ${formatInt(timestampDiffs)}`,
        `drift avg ${(driftSum / lines.length).toFixed(2)}s, max ${maxDrift.toFixed(2)}s`,
    ].join("; ");
    return firstTextDiff === null ? details : `${details}\n      first text difference at ${firstTextDiff}`;
}

/** Renders the token count table of one video, in order of raw token count. */
function renderTokenTable(results: TrackResult[]): string {
    return renderTable(
        ["Track", "Raw", "Unified", "vs raw", "Sentences", "vs raw", "vs unified"],
        results.map((result) => [
            trackLabel(result.captionFile),
            formatInt(result.rawTokens),
            formatInt(result.unifiedTokens),
            formatSaving(result.unifiedTokens, result.rawTokens),
            formatInt(result.sentenceTokens),
            formatSaving(result.sentenceTokens, result.rawTokens),
            formatSaving(result.sentenceTokens, result.unifiedTokens),
        ]),
    );
}

/** Renders line counts, sentence shape and transformation durations of one video's tracks. */
function renderShapeTable(results: TrackResult[]): string {
    return renderTable(
        [
            "Track",
            "Cue lines",
            "Raw units",
            "Sentences",
            "Avg words",
            "Max words",
            "1-word",
            "Fallback",
            "Extract ms",
            "Group ms",
        ],
        results.map((result) => {
            const wordCounts = result.sentences.map((sentence) => countWords(sentence.text));
            const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
            return [
                trackLabel(result.captionFile),
                formatInt(result.cues.length),
                formatInt(result.rawUnitCount),
                formatInt(result.sentences.length),
                (totalWords / Math.max(wordCounts.length, 1)).toFixed(1),
                formatInt(Math.max(0, ...wordCounts)),
                formatInt(wordCounts.filter((count) => count === 1).length),
                result.usedFallback ? "YES" : "no",
                result.extractMs.toFixed(2),
                result.groupMs.toFixed(2),
            ];
        }),
    );
}

/**
 * Renders the cross-format consistency checks of one video: every format's unified output
 * against the reference format, and every format's sentence lines against the format
 * with exact word-level timing.
 */
function renderConsistency(results: TrackResult[]): string {
    const sections: string[] = [];
    for (const kind of new Set(results.map((result) => result.captionFile.kind))) {
        const ofKind = results.filter((result) => result.captionFile.kind === kind);
        const reference = ofKind.find((result) => result.captionFile.format === REFERENCE_FORMAT);
        const wordLevel = ofKind.find((result) => result.captionFile.format === WORD_LEVEL_FORMAT);
        const lines = [`  ${kind} tracks, unified output compared to ${REFERENCE_FORMAT}:`];
        for (const result of ofKind) {
            if (!reference || result === reference) continue;
            lines.push(`    ${result.captionFile.format}: ${describeDifference(result.cues, reference.cues)}`);
        }
        lines.push(`  ${kind} tracks, sentence lines compared to ${WORD_LEVEL_FORMAT}:`);
        for (const result of ofKind) {
            if (!wordLevel || result === wordLevel) continue;
            lines.push(
                `    ${result.captionFile.format}: ${describeDifference(result.sentences, wordLevel.sentences)}`,
            );
        }
        sections.push(lines.join("\n"));
    }
    return sections.join("\n");
}

/**
 * Renders how sentence grouping behaves on a track without any punctuation, simulated by
 * stripping the sentence punctuation off a real track.
 */
function renderNoPunctuationCheck(result: TrackResult): string {
    const stripped = result.units.map((unit) =>
        isRawUnit(unit)
            ? unit
            : {
                  ...unit,
                  text: unit.text.replace(/[.!?…]/g, ""),
                  parts: unit.parts.map((part) => ({ ...part, text: part.text.replace(/[.!?…]/g, "") })),
              },
    );
    const grouping = groupSentences(stripped);
    return (
        `  ${result.captionFile.name} with all .!?… removed: ` +
        `${formatInt(grouping.lines.length)} lines from ${formatInt(stripped.length)} cues, ` +
        `fallback to cue lines: ${grouping.usedFallback ? "YES" : "no"}`
    );
}

const model = process.argv[2] ?? DEFAULT_MODEL;
const countTokens = await createTokenCounter(model);
const videos = await loadVideoInfos();
const unifiedDir = join(OUTPUT_DIR, "unified");
const sentencesDir = join(OUTPUT_DIR, "sentences");
await Promise.all([mkdir(unifiedDir, { recursive: true }), mkdir(sentencesDir, { recursive: true })]);

const results: TrackResult[] = [];
for (const captionFile of await listCaptionFiles()) {
    const raw = await file(captionFile.path).text();

    const extractStart = performance.now();
    const units = extractCaptionUnits(captionFile.format, raw);
    const unified = renderCaptionLines(units);
    const extractMs = performance.now() - extractStart;

    const groupStart = performance.now();
    const grouping = groupSentences(units);
    const sentenceText = renderCaptionLines(grouping.lines);
    const groupMs = performance.now() - groupStart;

    await write(join(unifiedDir, `${captionFile.name}.txt`), unified);
    await write(join(sentencesDir, `${captionFile.name}.txt`), sentenceText);

    const result: TrackResult = {
        captionFile,
        rawTokens: await countTokens(raw),
        units,
        cues: units.filter(isTimedLine),
        rawUnitCount: units.filter(isRawUnit).length,
        unifiedTokens: await countTokens(unified),
        extractMs,
        sentences: grouping.lines.filter(isTimedLine),
        usedFallback: grouping.usedFallback,
        sentenceTokens: await countTokens(sentenceText),
        groupMs,
    };
    console.log(
        `${captionFile.name}: raw ${formatInt(result.rawTokens)}, unified ${formatInt(result.unifiedTokens)}, ` +
            `sentences ${formatInt(result.sentenceTokens)}`,
    );
    results.push(result);
}
results.sort((a, b) => a.rawTokens - b.rawTokens);

const divider = "=".repeat(100);
const report = [
    "Token stats of pre-processed caption files",
    divider,
    "",
    `Model:     ${model} (@google/genai countTokens)`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Pipelines:",
    '  Raw        the caption file as downloaded (what the tool feeds the LLM today, for "srt")',
    '  Unified    one "<M:SS|H:MM:SS> <text>" line per cue; markup, end times, word timing dropped',
    "  Sentences  the unified cues regrouped into one line per sentence",
    "",
    'Tracks are "<kind> <language> <format>": "manual" = uploader provided, "auto" = automatic',
    "speech recognition. Durations are single runs without warm-up, so the first files processed",
    "include JIT compilation; extraction includes rendering, grouping excludes extraction.",
    '"1-word" counts sentences of a single word; "Max words" is the longest sentence;',
    '"Raw units" are cue-like units that failed to parse and are passed through verbatim.',
    "",
    ...videos.flatMap((video) => {
        const ofVideo = results.filter((result) => result.captionFile.videoId === video.id);
        return [
            divider,
            renderVideoHeader(video),
            "",
            "Token counts",
            "",
            renderTokenTable(ofVideo),
            "",
            "Line counts, sentence shape and transformation durations",
            "",
            renderShapeTable(ofVideo),
            "",
            "Cross-format consistency",
            "",
            renderConsistency(ofVideo),
            "",
        ];
    }),
    divider,
    "Edge case: no punctuation",
    "",
    ...results
        .filter((result) => result.captionFile.format === REFERENCE_FORMAT)
        .map((result) => renderNoPunctuationCheck(result)),
    "",
].join("\n");

await write(OUTPUT_FILE, report);
console.log(`\nWrote ${OUTPUT_FILE}`);
