/**
 * Extracts the cues of any caption format yt-dlp lists for YouTube (srv3, srt, json3,
 * srv1, ttml, vtt, srv2) into one intermediate representation.
 *
 * Extraction is defensive and works in two steps: the file is first segmented into
 * cue-like units (srt/vtt blocks, XML elements, json3 events), then every unit is
 * parsed on its own. A unit that looks like a cue but can't be parsed is kept verbatim
 * as a {@link RawUnit} instead of being dropped, so callers can both salvage it and
 * measure how much of a file failed to parse.
 *
 * Segmentation relies on cheap string scans and regexes rather than real XML parsing,
 * which is fine for the regular, machine-generated output of caption providers.
 *
 * Word-level timing of automatic srv2/srv3/vtt/json3 tracks is kept in {@link Cue.parts}
 * so that sentence grouping can label a sentence with the time of its first word.
 */

import { z } from "zod";

/** A piece of caption text and the time it starts being spoken. */
export interface TimedText {
    startMs: number;
    text: string;
}

/** One caption cue (a displayed line or block of lines). */
export interface Cue extends TimedText {
    /**
     * The finest-grained timed pieces making up the cue, in order. Word-level for
     * automatic srv2/srv3/vtt/json3 tracks, otherwise a single piece spanning the cue.
     * Piece texts keep their leading/trailing space, so joining them yields the cue text.
     */
    parts: TimedText[];
}

/** A unit that looked like a cue but could not be parsed, kept verbatim. */
export interface RawUnit {
    raw: string;
}

/** A segmented unit of a caption file: a parsed cue, or the raw text of a unit that failed to parse. */
export type CaptionUnit = Cue | RawUnit;

/** Outcome of parsing one unit: a cue, a unit without visible text, or one that can't be parsed. */
type UnitResult = Cue | "blank" | "invalid";

/** Narrows a unit (or rendered line) to one that failed to parse. */
export function isRawUnit(unit: TimedText | RawUnit): unit is RawUnit {
    return "raw" in unit;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes named and numeric XML/HTML entities; unknown entities are left untouched. */
function decodeEntities(text: string): string {
    if (!text.includes("&")) return text;
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
            return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
        }
        if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
        return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    });
}

/**
 * Decodes entities and collapses whitespace runs (including line wraps) to one space.
 *
 * @param raw - Raw text content
 * @param decodePasses - How often to decode entities (srv1/srv2 are double-escaped)
 */
function cleanText(raw: string, decodePasses: number): string {
    let text = raw;
    for (let pass = 0; pass < decodePasses; pass++) text = decodeEntities(text);
    return text.replace(/\s+/g, " ");
}

/** Builds a cue from its timed pieces, or "blank" if it has no visible text. */
function makeCue(startMs: number, parts: TimedText[]): Cue | "blank" {
    const visible = parts.filter((part) => part.text.trim() !== "");
    const text = visible
        .map((part) => part.text)
        .join("")
        .replace(/ {2,}/g, " ")
        .trim();
    return text === "" ? "blank" : { startMs, text, parts: visible };
}

/** Builds a cue whose only timed piece is the cue itself (no word-level timing). */
function makeSimpleCue(startMs: number, text: string): Cue | "blank" {
    return makeCue(startMs, [{ startMs, text: text.trim() }]);
}

/** Appends a parsed unit to the result: cues as they are, invalid units verbatim, blank ones not at all. */
function pushUnit(units: CaptionUnit[], result: UnitResult, raw: string): void {
    if (result === "invalid") units.push({ raw: raw.trim() });
    else if (result !== "blank") units.push(result);
}

/** Parses a `[H:]MM:SS[.mmm]` clock time (`,` or `.` as decimal separator) to milliseconds. */
function parseClock(clock: string): number | null {
    const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(clock.trim());
    if (!match) return null;
    const [, hours = "0", minutes = "0", seconds = "0", fraction = "0"] = match;
    return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

// ---------------------------------------------------------------------------
// srt / vtt
// ---------------------------------------------------------------------------

/** Timing line of an srt/vtt cue block; captures the start time and tolerates cue settings. */
const CUE_TIMING_LINE = /^[ \t]*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})[ \t]+-->[ \t]+\S+.*$/m;
/** Inline word timestamp of YouTube's automatic vtt tracks: `<00:00:00.360><c> might</c>`. */
const VTT_TIMED_WORD = /<((?:\d+:)?\d{1,2}:\d{2}\.\d{3})><c>([^<]*)<\/c>/g;
/** Blocks that are not cues: the vtt header, vtt comment/style/region blocks, and a stray srt index. */
const NON_CUE_BLOCK = /^(?:WEBVTT|NOTE|STYLE|REGION)\b|^\d+$/;

/**
 * Splits a timed line of an automatic vtt track into its word-level pieces. The text
 * before the first inline timestamp starts at the cue start.
 */
function parseVttTimedLine(line: string, cueStartMs: number): TimedText[] {
    const firstTag = line.indexOf("<");
    const parts: TimedText[] = [
        { startMs: cueStartMs, text: cleanText(firstTag === -1 ? line : line.slice(0, firstTag), 1) },
    ];
    for (const [, clock = "", word = ""] of line.matchAll(VTT_TIMED_WORD)) {
        parts.push({ startMs: parseClock(clock) ?? cueStartMs, text: cleanText(word, 1) });
    }
    return parts;
}

/**
 * Extracts the units of srt and vtt content, which share the same structure of blocks
 * separated by blank lines. A block without a timing line that isn't a known non-cue
 * block (e.g. the tail of a cue containing a blank line) is kept as a raw unit.
 *
 * YouTube's automatic vtt tracks use a rolling two-line display: every cue repeats the
 * previous line above the new one, and is followed by a 10 ms transition cue showing
 * only the settled line. Such tracks are recognized by their inline word timestamps;
 * for those only the new (last) line of each cue is kept, and transition cues (whose
 * last line is blank) are skipped.
 *
 * @param content - Raw srt or vtt file content
 * @param entityPasses - Entity decode passes (vtt escapes `&`, `<`, `>`; srt is plain text)
 */
function extractBlockUnits(content: string, entityPasses: number): CaptionUnit[] {
    const rolling = /<\d{2}:\d{2}:\d{2}\.\d{3}><c>/.test(content);
    const units: CaptionUnit[] = [];
    const normalized = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    for (const rawBlock of normalized.split(/\n{2,}/)) {
        const block = rawBlock.replace(/\n+$/, "");
        if (block.trim() === "") continue;

        const timing = CUE_TIMING_LINE.exec(block);
        const startMs = timing?.[1] === undefined ? null : parseClock(timing[1]);
        if (!timing || startMs === null) {
            if (!NON_CUE_BLOCK.test(block.trim())) units.push({ raw: block.trim() });
            continue;
        }

        const lines = block.slice(timing.index + timing[0].length).split("\n");
        const cue = rolling
            ? makeCue(startMs, parseVttTimedLine(lines.at(-1) ?? "", startMs))
            : // Strip inline markup such as <i> or <font>
              makeSimpleCue(startMs, cleanText(lines.join(" ").replace(/<[^>]+>/g, ""), entityPasses));
        pushUnit(units, cue, block);
    }
    return units;
}

// ---------------------------------------------------------------------------
// XML formats: ttml, srv1, srv2, srv3
// ---------------------------------------------------------------------------

/**
 * Segments XML content into the elements of one tag name, yielding each element from
 * its opening `<tag` up to (excluding) its closing tag. Anything between elements, such
 * as the document head, is skipped. Assumes the elements don't nest, which holds for
 * the cue elements of all supported formats.
 */
function* xmlElements(content: string, tag: string): Generator<string> {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let position = 0;
    for (let end = content.indexOf(close, position); end !== -1; end = content.indexOf(close, position)) {
        // Walk back to the nearest opening tag, skipping longer tag names sharing the prefix (<p vs <pen)
        let start = end > 0 ? content.lastIndexOf(open, end - 1) : -1;
        while (start >= position && !/[\s>]/.test(content.charAt(start + open.length))) {
            start = start > 0 ? content.lastIndexOf(open, start - 1) : -1;
        }
        if (start >= position) yield content.slice(start, end);
        position = end + close.length;
    }
}

/** Splits an element (without its closing tag) into its attribute string and body. */
function splitElement(element: string): { attributes: string; body: string } | null {
    const match = /^<[\w:-]+\b([^>]*)>([\s\S]*)$/.exec(element);
    return match ? { attributes: match[1] ?? "", body: match[2] ?? "" } : null;
}

/** `t="5280"`: start time (srv2, srv3 paragraphs) or word offset (srv3 words) in milliseconds. */
const MS_ATTRIBUTE = /\bt="(\d+)"/;
/** `start="5.28"`: srv1 start time in seconds. */
const SECONDS_ATTRIBUTE = /\bstart="([\d.]+)"/;
/** `begin="00:00:05.280"`: ttml start time. */
const BEGIN_ATTRIBUTE = /\bbegin="([^"]+)"/;

/** Reads a numeric XML attribute out of a tag's attribute string. */
function numericAttribute(attributes: string, pattern: RegExp): number | null {
    const value = pattern.exec(attributes)?.[1];
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Parses a ttml `<p begin="00:00:05.280" end="..." style="...">text<br />text</p>` element. */
function parseTtmlElement(element: string): UnitResult {
    const parsed = splitElement(element);
    const begin = parsed ? BEGIN_ATTRIBUTE.exec(parsed.attributes)?.[1] : undefined;
    const startMs = begin === undefined ? null : parseClock(begin);
    if (!parsed || startMs === null) return "invalid";
    // <br /> separates display lines; any other tag (e.g. <span>) is styling
    return makeSimpleCue(startMs, cleanText(parsed.body.replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, ""), 1));
}

/** Parses an srv1 `<text start="5.28" dur="4.68">text</text>` element; entities are double-escaped. */
function parseSrv1Element(element: string): UnitResult {
    const parsed = splitElement(element);
    const startSeconds = parsed ? numericAttribute(parsed.attributes, SECONDS_ATTRIBUTE) : null;
    if (!parsed || startSeconds === null) return "invalid";
    return makeSimpleCue(Math.round(startSeconds * 1000), cleanText(parsed.body.replace(/<[^>]+>/g, ""), 2));
}

/**
 * Parses an srv3 `<p t="5280" d="4680">text</p>` element. Automatic tracks nest one
 * `<s t="offsetMs">` element per word (offset relative to the paragraph) and interleave
 * newline-only padding paragraphs, which come out blank.
 */
function parseSrv3Element(element: string): UnitResult {
    const parsed = splitElement(element);
    const startMs = parsed ? numericAttribute(parsed.attributes, MS_ATTRIBUTE) : null;
    if (!parsed || startMs === null) return "invalid";
    if (!parsed.body.includes("<s")) {
        return makeSimpleCue(startMs, cleanText(parsed.body.replace(/<[^>]+>/g, ""), 1));
    }
    const parts: TimedText[] = [];
    for (const [, wordAttributes = "", word = ""] of parsed.body.matchAll(/<s\b([^>]*)>([^<]*)<\/s>/g)) {
        parts.push({
            startMs: startMs + (numericAttribute(wordAttributes, MS_ATTRIBUTE) ?? 0),
            text: cleanText(word, 1),
        });
    }
    return makeCue(startMs, parts);
}

/** Extracts the units of an XML format whose elements each map to one cue. */
function extractElementUnits(content: string, tag: string, parse: (element: string) => UnitResult): CaptionUnit[] {
    const units: CaptionUnit[] = [];
    for (const element of xmlElements(content, tag)) {
        pushUnit(units, parse(element), `${element}</${tag}>`);
    }
    return units;
}

/**
 * Extracts the units of srv2: `<text t="5280" d="4680">text</text>`, entities double-escaped.
 * Automatic tracks have one element per word; every word after the first of a line
 * carries `append="1"` and is folded into the cue started by the preceding element.
 */
function extractSrv2Units(content: string): CaptionUnit[] {
    const units: CaptionUnit[] = [];
    let pending: { startMs: number; parts: TimedText[] } | null = null;
    const flush = () => {
        if (pending) pushUnit(units, makeCue(pending.startMs, pending.parts), "");
        pending = null;
    };
    for (const element of xmlElements(content, "text")) {
        const parsed = splitElement(element);
        const startMs = parsed ? numericAttribute(parsed.attributes, MS_ATTRIBUTE) : null;
        if (!parsed || startMs === null) {
            flush();
            units.push({ raw: `${element}</text>` });
            continue;
        }
        const part = { startMs, text: cleanText(parsed.body.replace(/<[^>]+>/g, ""), 2) };
        if (pending && /\bappend="1"/.test(parsed.attributes)) {
            pending.parts.push(part);
        } else {
            flush();
            pending = { startMs, parts: [part] };
        }
    }
    flush();
    return units;
}

// ---------------------------------------------------------------------------
// json3
// ---------------------------------------------------------------------------

/** The top-level structure of YouTube's json3 caption format; events are validated one by one. */
const Json3Schema = z.object({ events: z.array(z.unknown()) });

/** The fields of a json3 event needed for cue extraction. */
const Json3EventSchema = z.object({
    tStartMs: z.number().optional(),
    segs: z.array(z.object({ utf8: z.string().optional(), tOffsetMs: z.number().optional() })).optional(),
});

/**
 * Extracts the units of json3: one event per cue, with a `segs` entry per word on automatic
 * tracks (`tOffsetMs` relative to the event). Window definition events (no segs) and
 * newline-only events are dropped as blank. The text needs no entity decoding.
 *
 * Unlike the other formats, a file that isn't valid JSON can't be segmented at all.
 *
 * @throws {SyntaxError | z.ZodError} When the content is not JSON or has no `events` array
 */
function extractJson3Units(content: string): CaptionUnit[] {
    const { events } = Json3Schema.parse(JSON.parse(content));
    const units: CaptionUnit[] = [];
    for (const rawEvent of events) {
        const event = Json3EventSchema.safeParse(rawEvent);
        if (!event.success) {
            units.push({ raw: JSON.stringify(rawEvent) });
            continue;
        }
        const { tStartMs, segs } = event.data;
        if (!segs) continue;
        if (tStartMs === undefined) {
            units.push({ raw: JSON.stringify(rawEvent) });
            continue;
        }
        const cue = makeCue(
            tStartMs,
            segs.map((seg) => ({ startMs: tStartMs + (seg.tOffsetMs ?? 0), text: cleanText(seg.utf8 ?? "", 0) })),
        );
        pushUnit(units, cue, "");
    }
    return units;
}

const EXTRACTORS: Record<string, (content: string) => CaptionUnit[]> = {
    srt: (content) => extractBlockUnits(content, 0),
    vtt: (content) => extractBlockUnits(content, 1),
    ttml: (content) => extractElementUnits(content, "p", parseTtmlElement),
    srv1: (content) => extractElementUnits(content, "text", parseSrv1Element),
    srv2: extractSrv2Units,
    srv3: (content) => extractElementUnits(content, "p", parseSrv3Element),
    json3: extractJson3Units,
};

/** Whether a caption format (the `ext` yt-dlp reports) has an extractor. */
export function isSupportedCaptionFormat(format: string): boolean {
    return Object.hasOwn(EXTRACTORS, format);
}

/**
 * Segments a caption file into units and parses each of them into a cue. Units that
 * look like cues but can't be parsed are returned verbatim as raw units, in place.
 *
 * @param format - Caption format, i.e. the `ext` yt-dlp reports (srt, vtt, ttml, srv1, srv2, srv3, json3)
 * @param content - Raw caption file content
 * @throws {Error} When the format is unsupported or the file can't be segmented at all (invalid json3)
 */
export function extractCaptionUnits(format: string, content: string): CaptionUnit[] {
    const extractor = isSupportedCaptionFormat(format) ? EXTRACTORS[format] : undefined;
    if (!extractor) throw new Error(`Unsupported caption format: ${format}`);
    return extractor(content);
}
