/**
 * TEMPORARY DIAGNOSTIC — classifies a raw Gemini response captured by `GeminiWireTap`, so that
 * each capture file can be named after what happened on the wire and, above all, after what
 * `@langchain/google` (0.2.3) silently loses on its streaming path.
 *
 * Labels (joined with `+` in the file name):
 * - `OK` — stream ended cleanly with `finishReason: STOP` and nothing was lost.
 * - `ADAPTER-DROPPED-FINAL-EVENT` — the last event was complete JSON but the body ended before its
 *   terminating blank line; eventsource-parser never dispatches it (it has no end-of-stream flush).
 * - `ADAPTER-IGNORED-ERROR` — an in-stream `{"error": …}` the adapter never raises. Google sends it as
 *   raw JSON with no `data:` prefix after a 200 (e.g. a mid-stream 503 UNAVAILABLE), whose lines
 *   eventsource-parser discards as unknown SSE fields; a `data:` event carrying an error has no
 *   candidates, so the adapter skips that too. `@google/genai` raises `ApiError` for the raw form.
 * - `ADAPTER-IGNORED-NON-SSE-TEXT` — any other text outside SSE fields, discarded by eventsource-parser.
 * - `ADAPTER-IGNORED-BLOCK` — a `promptFeedback.blockReason` event; the streaming path never raises
 *   `PromptBlockedError` (only the non-streaming path does).
 * - `ADAPTER-SKIPPED-NO-CANDIDATES` — any other event without candidates, skipped by the adapter.
 * - `ADAPTER-MALFORMED-JSON` — an event whose data is not JSON; the adapter turns it into an empty chunk.
 * - `CLOSED-MID-EVENT` — the body ended partway through an event's JSON (connection cut upstream or in
 *   transport; the adapter could not have parsed it, but it also does not raise).
 * - `CLOSED-WITHOUT-FINISH` — the body ended cleanly between events without any finish reason and
 *   nothing on the wire explains it (upstream or transport truncation, not raised by the adapter).
 * - `FINISH-<REASON>` — a non-`STOP` finish reason (e.g. `FINISH-MAX_TOKENS`); the adapter handles these.
 * - `STREAM-ERROR` / `CANCELLED` — reading the body threw / the consumer cancelled it.
 * - `HTTP-<status>` — non-2xx response; the adapter raises `RequestError` for these.
 * - `MALFORMED-JSON` / `NO-CANDIDATES` — non-streaming responses, where the adapter raises on both.
 */

/** How reading the tapped response body ended. */
export type BodyOutcome = "done" | "error" | "cancelled";

/** A captured response, as seen on the wire. */
export interface WireCapture {
    /** HTTP status code of the response. */
    status: number;
    /** Whether the response is an SSE stream (`streamGenerateContent?alt=sse`) rather than a single JSON body. */
    isSse: boolean;
    /** The decoded response body, verbatim. */
    raw: string;
    /** How reading the body ended. */
    outcome: BodyOutcome;
}

/** An event-level problem, with enough context to locate it in the capture file. */
interface WireAnomaly {
    /** Zero-based index of the event within the response; null for text outside any SSE event. */
    event: number | null;
    label: string;
    /** Start of the event's data. */
    excerpt: string;
}

/** Classification and wire-level statistics of a captured response. */
export interface WireAnalysis {
    /** File name labels, never empty. */
    labels: string[];
    /** Last finish reason Google sent, including in events the adapter dropped. */
    finishReason: string | null;
    eventCount: number;
    /** Whether the final SSE event was terminated by a blank line; null when there are no SSE events. */
    lastEventTerminated: boolean | null;
    /** Characters of non-thought text Google sent. */
    textChars: number;
    /** Characters of thought summaries Google sent. */
    thoughtChars: number;
    anomalies: WireAnomaly[];
}

/** One SSE event as delivered on the wire. */
interface SseEvent {
    /** `data:` field values joined with "\n", matching how eventsource-parser joins them. */
    data: string;
    /** False when the body ended before the blank line that dispatches the event. */
    terminated: boolean;
}

/** An SSE body split into its events and whatever else it contained. */
interface SseBody {
    events: SseEvent[];
    /** Lines that are not SSE fields at all, joined with "\n" (empty when there are none). */
    strayText: string;
}

/** What a single decoded Gemini response object contributes to the analysis. */
interface CandidateStats {
    finishReason: string | null;
    textChars: number;
    thoughtChars: number;
}

const EXCERPT_CHARS = 200;

const Label = {
    droppedFinalEvent: "ADAPTER-DROPPED-FINAL-EVENT",
    ignoredError: "ADAPTER-IGNORED-ERROR",
    ignoredNonSseText: "ADAPTER-IGNORED-NON-SSE-TEXT",
    ignoredBlock: "ADAPTER-IGNORED-BLOCK",
    skippedNoCandidates: "ADAPTER-SKIPPED-NO-CANDIDATES",
    adapterMalformedJson: "ADAPTER-MALFORMED-JSON",
    closedMidEvent: "CLOSED-MID-EVENT",
    closedWithoutFinish: "CLOSED-WITHOUT-FINISH",
    streamError: "STREAM-ERROR",
    cancelled: "CANCELLED",
    malformedJson: "MALFORMED-JSON",
    noCandidates: "NO-CANDIDATES",
    ok: "OK",
} as const;

/**
 * Classifies a captured Gemini response.
 *
 * @param capture - The response status, raw body, and how reading the body ended
 * @returns File name labels plus wire-level statistics for the capture summary
 */
export function analyzeGeminiCapture(capture: WireCapture): WireAnalysis {
    const analysis: WireAnalysis = {
        labels: [],
        finishReason: null,
        eventCount: 0,
        lastEventTerminated: null,
        textChars: 0,
        thoughtChars: 0,
        anomalies: [],
    };
    const labels = new Set<string>();

    if (capture.status < 200 || capture.status >= 300) {
        // Error bodies are plain JSON handled by RequestError; there are no events to inspect.
        labels.add(`HTTP-${capture.status}`);
    } else if (capture.isSse) {
        analyzeSseEvents(splitSseEvents(capture.raw), analysis, labels);
    } else {
        analyzeUnaryBody(capture.raw, analysis, labels);
    }

    if (capture.outcome === "error") labels.add(Label.streamError);
    if (capture.outcome === "cancelled") labels.add(Label.cancelled);

    const isSuccessStatus = capture.status >= 200 && capture.status < 300;
    const missingFinishIsExplained =
        labels.has(Label.closedMidEvent) || labels.has(Label.ignoredError) || labels.has(Label.ignoredBlock);
    if (
        isSuccessStatus &&
        capture.isSse &&
        capture.outcome === "done" &&
        analysis.finishReason === null &&
        !missingFinishIsExplained
    ) {
        labels.add(Label.closedWithoutFinish);
    }

    if (analysis.finishReason !== null && analysis.finishReason.toUpperCase() !== "STOP") {
        labels.add(`FINISH-${analysis.finishReason}`);
    }

    analysis.labels = labels.size > 0 ? [...labels] : [Label.ok];
    return analysis;
}

/**
 * Splits a raw SSE body into events the way the SSE spec defines them, but — unlike the
 * adapter's parser — also returns the trailing event the body ended in the middle of, and
 * keeps lines that are not SSE fields at all instead of discarding them.
 * Only `data:` fields are collected as event content; Gemini sends no other fields.
 */
function splitSseEvents(raw: string): SseBody {
    const lines = raw.replace(/^﻿/, "").split(/\r\n|\r|\n/);
    // Whatever follows the last line break is an incomplete line (empty when the body ended on a break).
    const incompleteLine = lines.pop() ?? "";

    const events: SseEvent[] = [];
    const strayLines: string[] = [];
    let dataLines: string[] = [];
    for (const line of lines) {
        if (line === "") {
            if (dataLines.length > 0) events.push({ data: dataLines.join("\n"), terminated: true });
            dataLines = [];
        } else if (line.startsWith("data:")) {
            dataLines.push(readDataField(line));
        } else if (!SSE_NON_DATA_LINE.test(line)) {
            strayLines.push(line);
        }
    }

    if (incompleteLine.startsWith("data:")) dataLines.push(readDataField(incompleteLine));
    else if (incompleteLine !== "" && !SSE_NON_DATA_LINE.test(incompleteLine)) strayLines.push(incompleteLine);
    if (dataLines.length > 0) events.push({ data: dataLines.join("\n"), terminated: false });
    return { events, strayText: strayLines.join("\n") };
}

/** SSE lines that are legitimate but carry no event data: comments and the `event`, `id`, `retry` fields. */
const SSE_NON_DATA_LINE = /^(?::|event:|id:|retry:)/;

/** Returns a `data:` line's value, dropping the single optional space after the colon. */
function readDataField(line: string): string {
    return line.slice(line.startsWith("data: ") ? 6 : 5);
}

/**
 * Labels text outside any SSE event, which eventsource-parser discards as unknown fields.
 * Google uses this form for errors that occur after the 200 response has started streaming.
 */
function analyzeStrayText(strayText: string, analysis: WireAnalysis, labels: Set<string>): void {
    if (strayText.trim() === "") return;
    const parsed = parseJson(strayText);
    const label = isRecord(parsed) && "error" in parsed ? Label.ignoredError : Label.ignoredNonSseText;
    labels.add(label);
    analysis.anomalies.push({ event: null, label, excerpt: strayText.slice(0, EXCERPT_CHARS) });
}

/** Labels SSE events by what the adapter's streaming path does with each of them. */
function analyzeSseEvents({ events, strayText }: SseBody, analysis: WireAnalysis, labels: Set<string>): void {
    analysis.eventCount = events.length;
    analysis.lastEventTerminated = events.at(-1)?.terminated ?? null;

    events.forEach((event, index) => {
        const flag = (label: string) => {
            labels.add(label);
            analysis.anomalies.push({ event: index, label, excerpt: event.data.slice(0, EXCERPT_CHARS) });
        };
        const parsed = parseJson(event.data);

        if (!event.terminated) {
            // The adapter never sees an unterminated event. If its JSON is complete, the adapter threw
            // away data that fully arrived; if not, the connection itself was cut mid-event.
            if (parsed === undefined) {
                flag(Label.closedMidEvent);
                return;
            }
            flag(Label.droppedFinalEvent);
        } else if (parsed === undefined) {
            flag(Label.adapterMalformedJson);
            return;
        }

        const body = isRecord(parsed) ? parsed : {};
        const stats = readCandidateStats(body);
        if (stats === null) {
            // Unterminated events were already flagged as dropped; don't double-label them as skipped.
            if (!event.terminated) return;
            if ("error" in body) flag(Label.ignoredError);
            else if (hasBlockReason(body)) flag(Label.ignoredBlock);
            else flag(Label.skippedNoCandidates);
            return;
        }
        accumulate(analysis, stats);
    });

    analyzeStrayText(strayText, analysis, labels);
}

/** Labels a non-streaming `generateContent` body, where the adapter raises on every anomaly. */
function analyzeUnaryBody(raw: string, analysis: WireAnalysis, labels: Set<string>): void {
    const parsed = parseJson(raw);
    if (parsed === undefined) {
        labels.add(Label.malformedJson);
        return;
    }
    analysis.eventCount = 1;
    const stats = readCandidateStats(isRecord(parsed) ? parsed : {});
    if (stats === null) {
        labels.add(Label.noCandidates);
        return;
    }
    accumulate(analysis, stats);
}

/** Folds one response object's candidate stats into the running analysis; the last finish reason wins. */
function accumulate(analysis: WireAnalysis, stats: CandidateStats): void {
    analysis.textChars += stats.textChars;
    analysis.thoughtChars += stats.thoughtChars;
    if (stats.finishReason !== null) analysis.finishReason = stats.finishReason;
}

/**
 * Reads the first candidate of a Gemini response object.
 *
 * @returns null when there is no first candidate — the same condition under which the adapter
 *   skips the event (`if (!candidate) return;`)
 */
function readCandidateStats(body: Record<string, unknown>): CandidateStats | null {
    const candidate = Array.isArray(body.candidates) ? body.candidates[0] : undefined;
    if (!isRecord(candidate)) return null;

    const content = candidate.content;
    const parts = isRecord(content) && Array.isArray(content.parts) ? content.parts : [];
    const stats: CandidateStats = {
        finishReason: typeof candidate.finishReason === "string" ? candidate.finishReason : null,
        textChars: 0,
        thoughtChars: 0,
    };
    for (const part of parts) {
        if (!isRecord(part) || typeof part.text !== "string") continue;
        if (part.thought === true) stats.thoughtChars += part.text.length;
        else stats.textChars += part.text.length;
    }
    return stats;
}

function hasBlockReason(body: Record<string, unknown>): boolean {
    return isRecord(body.promptFeedback) && body.promptFeedback.blockReason !== undefined;
}

/** Parses JSON, returning undefined (never a valid JSON value) when the text is not valid JSON. */
function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
