import { describe, expect, test } from "bun:test";
import { analyzeGeminiCapture, type WireCapture } from "../../../src/infrastructure/llm/debug/geminiWireAnalysis.ts";

/** Serializes a Gemini response object as one SSE event, terminated the way Gemini terminates events. */
function sseEvent(body: unknown, terminator = "\r\n\r\n"): string {
    return `data: ${JSON.stringify(body)}${terminator}`;
}

function textChunk(text: string, finishReason?: string, thought = false) {
    return {
        candidates: [
            {
                content: { role: "model", parts: [{ text, ...(thought && { thought: true }) }] },
                ...(finishReason && { finishReason }),
            },
        ],
    };
}

function sse(raw: string, overrides: Partial<WireCapture> = {}): WireCapture {
    return { status: 200, isSse: true, raw, outcome: "done", ...overrides };
}

describe("analyzeGeminiCapture — SSE streams", () => {
    test("labels a cleanly finished stream OK and counts text and thought characters", () => {
        const raw =
            sseEvent(textChunk("thinking", undefined, true)) +
            sseEvent(textChunk("Hello")) +
            sseEvent(textChunk(" world", "STOP"));

        const analysis = analyzeGeminiCapture(sse(raw));

        expect(analysis.labels).toEqual(["OK"]);
        expect(analysis.finishReason).toBe("STOP");
        expect(analysis.eventCount).toBe(3);
        expect(analysis.lastEventTerminated).toBe(true);
        expect(analysis.textChars).toBe("Hello world".length);
        expect(analysis.thoughtChars).toBe("thinking".length);
        expect(analysis.anomalies).toEqual([]);
    });

    test("accepts LF-only terminators, data fields without a space, and multi-line data", () => {
        const raw = `data:${JSON.stringify(textChunk("a"))}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"b"}]},\ndata: "finishReason":"STOP"}]}\n\n`;

        const analysis = analyzeGeminiCapture(sse(raw));

        expect(analysis.labels).toEqual(["OK"]);
        expect(analysis.eventCount).toBe(2);
        expect(analysis.textChars).toBe(2);
    });

    test.each([
        ["a single line break", "\r\n"],
        ["no line break", ""],
    ])("flags a complete final event followed by %s as dropped by the adapter", (_name, terminator) => {
        const raw = sseEvent(textChunk("Hello")) + sseEvent(textChunk(" world", "STOP"), terminator);

        const analysis = analyzeGeminiCapture(sse(raw));

        expect(analysis.labels).toEqual(["ADAPTER-DROPPED-FINAL-EVENT"]);
        // The finish reason did arrive on the wire, so the stream is not also labeled as closed without one.
        expect(analysis.finishReason).toBe("STOP");
        expect(analysis.lastEventTerminated).toBe(false);
        expect(analysis.textChars).toBe("Hello world".length);
        expect(analysis.anomalies).toEqual([
            expect.objectContaining({ event: 1, label: "ADAPTER-DROPPED-FINAL-EVENT" }),
        ]);
    });

    test("labels a body cut partway through an event's JSON as closed mid-event", () => {
        const raw = `${sseEvent(textChunk("Hello"))}data: {"candidates":[{"content":{"parts":[{"text":" wor`;

        const analysis = analyzeGeminiCapture(sse(raw));

        expect(analysis.labels).toEqual(["CLOSED-MID-EVENT"]);
        expect(analysis.finishReason).toBeNull();
    });

    test("flags an in-stream error event as ignored by the adapter", () => {
        const raw =
            sseEvent(textChunk("Hello")) +
            sseEvent({ error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } });

        const analysis = analyzeGeminiCapture(sse(raw));

        expect(analysis.labels).toEqual(["ADAPTER-IGNORED-ERROR"]);
        expect(analysis.anomalies[0]?.excerpt).toContain("INTERNAL");
    });

    test("flags a raw non-SSE error object after a 200 as ignored by the adapter, not as a plain truncation", () => {
        // The exact shape Gemini sends when a streaming generation fails with 503 partway through.
        const rawError =
            '{\n  "error": {\n    "code": 503,\n    "message": "This model is currently experiencing high demand.",\n    "status": "UNAVAILABLE"\n  }\n}\n';
        const raw = sseEvent(textChunk("**No, you")) + sseEvent(textChunk(" cannot play")) + rawError;

        const analysis = analyzeGeminiCapture(sse(raw));

        expect(analysis.labels).toEqual(["ADAPTER-IGNORED-ERROR"]);
        expect(analysis.eventCount).toBe(2);
        expect(analysis.textChars).toBe("**No, you cannot play".length);
        expect(analysis.anomalies).toEqual([
            { event: null, label: "ADAPTER-IGNORED-ERROR", excerpt: expect.stringContaining('"code": 503') },
        ]);
    });

    test("flags other text outside SSE fields, but not comments or known fields", () => {
        const raw = `: keep-alive\nevent: message\nid: 1\nretry: 100\n${sseEvent(textChunk("Hello", "STOP"))}<html>oops</html>`;

        expect(analyzeGeminiCapture(sse(raw)).labels).toEqual(["ADAPTER-IGNORED-NON-SSE-TEXT"]);
        expect(analyzeGeminiCapture(sse(raw.replace("<html>oops</html>", ""))).labels).toEqual(["OK"]);
    });

    test("flags a prompt block event as ignored by the adapter", () => {
        const raw = sseEvent({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } });

        expect(analyzeGeminiCapture(sse(raw)).labels).toEqual(["ADAPTER-IGNORED-BLOCK"]);
    });

    test("flags other candidate-less events as skipped, alongside the missing finish reason", () => {
        const raw = sseEvent(textChunk("Hello")) + sseEvent({ candidates: [], usageMetadata: { totalTokenCount: 5 } });

        expect(analyzeGeminiCapture(sse(raw)).labels).toEqual([
            "ADAPTER-SKIPPED-NO-CANDIDATES",
            "CLOSED-WITHOUT-FINISH",
        ]);
    });

    test("flags a terminated event with invalid JSON as malformed", () => {
        const raw = `data: {not json\r\n\r\n${sseEvent(textChunk("Hello", "STOP"))}`;

        expect(analyzeGeminiCapture(sse(raw)).labels).toEqual(["ADAPTER-MALFORMED-JSON"]);
    });

    test("labels a clean close between events without any finish reason", () => {
        const analysis = analyzeGeminiCapture(sse(sseEvent(textChunk("Hello"))));

        expect(analysis.labels).toEqual(["CLOSED-WITHOUT-FINISH"]);
    });

    test("labels an empty body as closed without finish", () => {
        const analysis = analyzeGeminiCapture(sse(""));

        expect(analysis.labels).toEqual(["CLOSED-WITHOUT-FINISH"]);
        expect(analysis.lastEventTerminated).toBeNull();
    });

    test("labels non-STOP finish reasons", () => {
        const raw = sseEvent(textChunk("Hello", "MAX_TOKENS"));

        expect(analyzeGeminiCapture(sse(raw)).labels).toEqual(["FINISH-MAX_TOKENS"]);
    });

    test.each([
        ["error", "STREAM-ERROR"],
        ["cancelled", "CANCELLED"],
    ] as const)("labels a %s body read without also calling it closed without finish", (outcome, label) => {
        const analysis = analyzeGeminiCapture(sse(sseEvent(textChunk("Hello")), { outcome }));

        expect(analysis.labels).toEqual([label]);
    });

    test("labels non-2xx responses by status without inspecting events", () => {
        const raw = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });

        expect(analyzeGeminiCapture(sse(raw, { status: 429 })).labels).toEqual(["HTTP-429"]);
    });
});

describe("analyzeGeminiCapture — non-streaming responses", () => {
    test("labels a finished response OK", () => {
        const raw = JSON.stringify(textChunk("Hello", "STOP"));

        const analysis = analyzeGeminiCapture({ status: 200, isSse: false, raw, outcome: "done" });

        expect(analysis.labels).toEqual(["OK"]);
        expect(analysis.textChars).toBe(5);
    });

    test("labels responses without candidates or with invalid JSON without the adapter prefix", () => {
        expect(analyzeGeminiCapture({ status: 200, isSse: false, raw: "{}", outcome: "done" }).labels).toEqual([
            "NO-CANDIDATES",
        ]);
        expect(analyzeGeminiCapture({ status: 200, isSse: false, raw: "{", outcome: "done" }).labels).toEqual([
            "MALFORMED-JSON",
        ]);
    });
});
