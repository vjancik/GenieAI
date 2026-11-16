/**
 * Regroups extracted caption cues into one timed line per sentence, so that every line
 * is a complete statement labeled with the time it starts at, and far fewer timestamps
 * are spent than with one line per cue.
 *
 * Works on the cues' finest-grained timed pieces: with word-level timing (automatic
 * srv2/srv3/vtt/json3 tracks) a sentence gets the exact time of its first word, otherwise
 * the start of the cue its first word sits in (i.e. at most one cue early).
 */

import { type CaptionUnit, type Cue, isRawUnit, type RawUnit, type TimedText } from "./captionExtractors.ts";

/** A line of formatted captions: timed text, or the verbatim text of a unit that failed to parse. */
export type CaptionLine = TimedText | RawUnit;

/**
 * A sentence boundary: either terminal punctuation (plus closing quotes/brackets) followed
 * by whitespace, or the whitespace before a `>>` speaker change marker. A lowercase letter
 * after the punctuation means an abbreviation ("e.g. the", "vs. them") rather than a
 * sentence end. Decimals and domains ("4.5", "nasa.gov") have no whitespace, so never match.
 */
const SENTENCE_BOUNDARY = /[.!?…]+["'”’)\]]*\s+(?![a-z])|\s+(?=>>)/g;

/**
 * Above this average sentence length the track is considered to lack usable punctuation
 * (as some automatic tracks do), and the cues are kept as they are.
 */
const MAX_AVERAGE_SENTENCE_WORDS = 50;

/** Result of sentence grouping. */
export interface SentenceGrouping {
    /** One line per sentence, or the unchanged units when `usedFallback` is set. */
    lines: CaptionLine[];
    /** Whether punctuation was too sparse to split on, so the cue lines were kept. */
    usedFallback: boolean;
}

/** Counts the whitespace separated words of a text. */
export function countWords(text: string): number {
    return text.split(" ").filter((word) => word !== "").length;
}

/** Splits a run of consecutive cues into sentences, each timed by the piece its first word sits in. */
function splitSentences(cues: Cue[]): TimedText[] {
    // Concatenate all pieces into one transcript, remembering where each piece starts in it
    let transcript = "";
    const pieceOffsets: number[] = [];
    const pieceStarts: number[] = [];
    for (const cue of cues) {
        if (transcript !== "" && !transcript.endsWith(" ")) transcript += " ";
        for (const part of cue.parts) {
            const text = transcript === "" || transcript.endsWith(" ") ? part.text.trimStart() : part.text;
            // The piece's own start is its first visible character, not its leading space
            pieceOffsets.push(transcript.length + (text.length - text.trimStart().length));
            pieceStarts.push(part.startMs);
            transcript += text;
        }
    }

    const sentenceOffsets = [0];
    for (const match of transcript.matchAll(SENTENCE_BOUNDARY)) {
        sentenceOffsets.push(match.index + match[0].length);
    }

    const sentences: TimedText[] = [];
    // Both offset lists ascend, so one forward-only cursor finds each sentence's first piece
    let piece = 0;
    for (const [i, offset] of sentenceOffsets.entries()) {
        const text = transcript.slice(offset, sentenceOffsets[i + 1] ?? transcript.length).trim();
        if (text === "") continue;
        while ((pieceOffsets[piece + 1] ?? Number.POSITIVE_INFINITY) <= offset) piece++;
        sentences.push({ startMs: pieceStarts[piece] ?? 0, text });
    }
    return sentences;
}

/**
 * Regroups cues into one timed line per sentence. Raw units stay where they are and
 * act as hard breaks: a sentence never continues across one. Falls back to the
 * unchanged units when the track has no (or far too little) sentence punctuation.
 *
 * @param units - Units from caption extraction
 */
export function groupSentences(units: CaptionUnit[]): SentenceGrouping {
    const lines: CaptionLine[] = [];
    let sentenceCount = 0;
    let wordCount = 0;
    let run: Cue[] = [];
    const flushRun = () => {
        for (const sentence of splitSentences(run)) {
            lines.push(sentence);
            sentenceCount++;
            wordCount += countWords(sentence.text);
        }
        run = [];
    };
    for (const unit of units) {
        if (isRawUnit(unit)) {
            flushRun();
            lines.push(unit);
        } else {
            run.push(unit);
        }
    }
    flushRun();

    if (sentenceCount === 0 || wordCount / sentenceCount > MAX_AVERAGE_SENTENCE_WORDS) {
        return { lines: units, usedFallback: true };
    }
    return { lines, usedFallback: false };
}
