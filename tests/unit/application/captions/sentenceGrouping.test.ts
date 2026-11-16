import { describe, expect, test } from "bun:test";
import type { CaptionUnit, Cue } from "../../../../src/application/formatters/captions/captionExtractors.ts";
import { countWords, groupSentences } from "../../../../src/application/formatters/captions/sentenceGrouping.ts";

/** Builds a cue without word-level timing. */
function cue(startMs: number, text: string): Cue {
    return { startMs, text, parts: [{ startMs, text }] };
}

/** Builds a cue with one timed piece per word, `stepMs` apart. */
function wordCue(startMs: number, text: string, stepMs: number): Cue {
    const parts = text
        .split(" ")
        .map((word, i) => ({ startMs: startMs + i * stepMs, text: i === 0 ? word : ` ${word}` }));
    return { startMs, text, parts };
}

describe("countWords", () => {
    test("counts whitespace separated words", () => {
        expect(countWords("")).toBe(0);
        expect(countWords("one")).toBe(1);
        expect(countWords("one  two three")).toBe(3);
    });
});

describe("groupSentences", () => {
    test("joins cues into sentences timed by the cue their first word sits in", () => {
        const units = [
            cue(0, "This is the first"),
            cue(3000, "sentence. And here comes"),
            cue(6000, "the second one."),
        ];
        expect(groupSentences(units)).toEqual({
            lines: [
                { startMs: 0, text: "This is the first sentence." },
                { startMs: 3000, text: "And here comes the second one." },
            ],
            usedFallback: false,
        });
    });

    test("uses the exact time of a sentence's first word when cues have word-level timing", () => {
        const units = [wordCue(0, "This is the first", 500), wordCue(3000, "sentence. And here comes", 500)];
        expect(groupSentences(units).lines).toEqual([
            { startMs: 0, text: "This is the first sentence." },
            { startMs: 3500, text: "And here comes" },
        ]);
    });

    test("splits on question marks, exclamation marks and closing quotes", () => {
        const units = [cue(0, 'Really? Yes! He said "go." Then we left')];
        expect(groupSentences(units).lines.map((line) => "text" in line && line.text)).toEqual([
            "Really?",
            "Yes!",
            'He said "go."',
            "Then we left",
        ]);
    });

    test("does not split on abbreviations, decimals and domains", () => {
        const units = [cue(0, "It costs 4.5 dollars, e.g. at nasa.gov, vs. more elsewhere. Next sentence.")];
        expect(groupSentences(units).lines.map((line) => "text" in line && line.text)).toEqual([
            "It costs 4.5 dollars, e.g. at nasa.gov, vs. more elsewhere.",
            "Next sentence.",
        ]);
    });

    test("starts a new line at a >> speaker change even without punctuation", () => {
        const units = [cue(0, "and that is how it works"), cue(4000, ">> Interesting, tell me more.")];
        expect(groupSentences(units).lines).toEqual([
            { startMs: 0, text: "and that is how it works" },
            { startMs: 4000, text: ">> Interesting, tell me more." },
        ]);
    });

    test("keeps raw units in place and never continues a sentence across one", () => {
        const units: CaptionUnit[] = [
            cue(0, "This sentence is cut"),
            { raw: "<p>garbage</p>" },
            cue(5000, "short. Done."),
        ];
        expect(groupSentences(units)).toEqual({
            lines: [
                { startMs: 0, text: "This sentence is cut" },
                { raw: "<p>garbage</p>" },
                { startMs: 5000, text: "short." },
                { startMs: 5000, text: "Done." },
            ],
            usedFallback: false,
        });
    });

    test("falls back to the unchanged cues when there is no punctuation", () => {
        const units = Array.from({ length: 12 }, (_, i) => cue(i * 3000, "just words flowing on without any stop"));
        const grouping = groupSentences(units);
        expect(grouping.usedFallback).toBe(true);
        expect(grouping.lines).toBe(units);
    });

    test("falls back when there are no cues at all", () => {
        expect(groupSentences([])).toEqual({ lines: [], usedFallback: true });
        const onlyRaw = [{ raw: "garbage" }];
        expect(groupSentences(onlyRaw)).toEqual({ lines: onlyRaw, usedFallback: true });
    });
});
