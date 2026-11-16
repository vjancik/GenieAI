import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { file } from "bun";
import {
    type CaptionUnit,
    type Cue,
    extractCaptionUnits,
    isRawUnit,
    isSupportedCaptionFormat,
} from "../../../../src/application/formatters/captions/captionExtractors.ts";

const FORMATS = ["srv3", "srt", "json3", "srv1", "ttml", "vtt", "srv2"];
/** Formats whose automatic tracks carry a start time per word. */
const WORD_LEVEL_FORMATS = ["srv3", "json3", "vtt", "srv2"];

/**
 * Loads a fixture: the first 40 seconds of a real YouTube video's uploader-provided
 * ("manual") or automatic ("auto") English track, as downloaded in the given format.
 */
function loadFixture(kind: "manual" | "auto", format: string): Promise<string> {
    return file(join(import.meta.dir, "data", `${kind}.en.${format}`)).text();
}

/** Asserts no unit failed to parse and returns the units as cues. */
function expectCues(units: CaptionUnit[]): Cue[] {
    const cues = units.filter((unit): unit is Cue => !isRawUnit(unit));
    expect(cues.length).toBe(units.length);
    return cues;
}

/** Reduces cues to their start time and text, dropping the format-specific pieces. */
function summarize(cues: Cue[]) {
    return cues.map(({ startMs, text }) => ({ startMs, text }));
}

describe("isSupportedCaptionFormat", () => {
    test("accepts every format with an extractor", () => {
        for (const format of FORMATS) expect(isSupportedCaptionFormat(format)).toBe(true);
    });

    test("rejects unknown formats and inherited object keys", () => {
        expect(isSupportedCaptionFormat("sbv")).toBe(false);
        expect(isSupportedCaptionFormat("toString")).toBe(false);
        expect(() => extractCaptionUnits("sbv", "")).toThrow("Unsupported caption format");
    });
});

describe("extractCaptionUnits on real tracks", () => {
    test("uploader-provided track: line wraps are joined and entities decoded", async () => {
        const cues = expectCues(extractCaptionUnits("srv1", await loadFixture("manual", "srv1")));
        expect(cues.length).toBe(17);
        expect(summarize(cues).slice(0, 2)).toEqual([
            { startMs: 34, text: "- This might be the most ambitious long shot precision" },
            { startMs: 3920, text: "experiment that I've ever seen." },
        ]);
    });

    test("automatic track: speaker markers and apostrophes are decoded", async () => {
        const cues = expectCues(extractCaptionUnits("srv1", await loadFixture("auto", "srv1")));
        expect(cues.length).toBe(20);
        expect(cues[0]).toEqual({
            startMs: 0,
            text: "This might be the most ambitious long",
            parts: [{ startMs: 0, text: "This might be the most ambitious long" }],
        });
        expect(cues[1]?.text).toBe("shot precision experiment that I've ever");
        expect(cues.some((cue) => cue.text.startsWith(">> If you go into a science center"))).toBe(true);
    });

    for (const kind of ["manual", "auto"] as const) {
        for (const format of FORMATS.filter((candidate) => candidate !== "srv1")) {
            test(`${kind} ${format} yields the same cues as srv1`, async () => {
                const reference = expectCues(extractCaptionUnits("srv1", await loadFixture(kind, "srv1")));
                const cues = expectCues(extractCaptionUnits(format, await loadFixture(kind, format)));
                expect(summarize(cues)).toEqual(summarize(reference));
            });
        }
    }

    for (const format of WORD_LEVEL_FORMATS) {
        test(`automatic ${format} keeps a start time per word`, async () => {
            const cues = expectCues(extractCaptionUnits(format, await loadFixture("auto", format)));
            expect(cues[0]?.parts.map((part) => part.startMs)).toEqual([0, 360, 680, 920, 1280, 1800, 2560]);
            expect(cues[0]?.parts.map((part) => part.text.trim())).toEqual([
                "This",
                "might",
                "be",
                "the",
                "most",
                "ambitious",
                "long",
            ]);
        });
    }

    test("uploader-provided tracks have one piece per cue in every format", async () => {
        for (const format of FORMATS) {
            const cues = expectCues(extractCaptionUnits(format, await loadFixture("manual", format)));
            expect(cues.every((cue) => cue.parts.length === 1)).toBe(true);
        }
    });
});

describe("extractCaptionUnits on empty files", () => {
    const EMPTY_FILES: Record<string, string> = {
        srt: "",
        vtt: "WEBVTT\nKind: captions\nLanguage: en\n",
        ttml: '<?xml version="1.0" encoding="utf-8" ?><tt><head></head><body><div></div></body></tt>',
        srv1: '<?xml version="1.0" encoding="utf-8" ?><transcript></transcript>',
        srv2: '<?xml version="1.0" encoding="utf-8" ?><timedtext></timedtext>',
        srv3: '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><pen id="1"/></head><body></body></timedtext>',
        json3: '{"wireMagic":"pb3","events":[{"tStartMs":0,"dDurationMs":1000,"id":1}]}',
    };

    for (const [format, content] of Object.entries(EMPTY_FILES)) {
        test(`${format} without cues yields no units`, () => {
            expect(extractCaptionUnits(format, content)).toEqual([]);
        });
    }

    test("cues without visible text are dropped", () => {
        expect(extractCaptionUnits("srt", "1\n00:00:01,000 --> 00:00:02,000\n \n")).toEqual([]);
        expect(extractCaptionUnits("srv3", '<body><p t="10" d="5" a="1">\n</p></body>')).toEqual([]);
    });
});

describe("extractCaptionUnits keeps unparseable units verbatim", () => {
    test("srt: a block without a timing line is kept, a stray index is not", () => {
        const content = [
            "1\r\n00:00:01,000 --> 00:00:03,000\r\nFirst line\r\nsecond line",
            "tail of a cue that contained a blank line",
            "7",
            "2\r\n00:00:03,000 --> 00:00:05,000\r\n<i>Third</i> line",
        ].join("\r\n\r\n");
        expect(extractCaptionUnits("srt", content)).toEqual([
            {
                startMs: 1000,
                text: "First line second line",
                parts: [{ startMs: 1000, text: "First line second line" }],
            },
            { raw: "tail of a cue that contained a blank line" },
            { startMs: 3000, text: "Third line", parts: [{ startMs: 3000, text: "Third line" }] },
        ]);
    });

    test("vtt: header, NOTE and STYLE blocks are skipped, hour-less times and cue settings parsed", () => {
        const content = [
            "﻿WEBVTT",
            "NOTE made by hand",
            "STYLE\n::cue { color: red }",
            "00:01.500 --> 00:03.000 align:start position:0%\nTom &amp; Jerry &lt;3",
            "1:00:01.000 --> 1:00:03.000\nOne hour in",
            "garbage block",
        ].join("\n\n");
        const units = extractCaptionUnits("vtt", content);
        expect(units.map((unit) => (isRawUnit(unit) ? unit : { startMs: unit.startMs, text: unit.text }))).toEqual([
            { startMs: 1500, text: "Tom & Jerry <3" },
            { startMs: 3_601_000, text: "One hour in" },
            { raw: "garbage block" },
        ]);
    });

    test("srv1: an element without a start time is kept, entities are decoded twice", () => {
        const content =
            '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
            '<text start="1.5" dur="2">Tom &amp;amp; Jerry&amp;#39;s</text>' +
            '<text begin="3" dur="2">no start</text>' +
            '<text start="5" dur="2">last</text></transcript>';
        const units = extractCaptionUnits("srv1", content);
        expect(units.map((unit) => (isRawUnit(unit) ? unit : unit.text))).toEqual([
            "Tom & Jerry's",
            { raw: '<text begin="3" dur="2">no start</text>' },
            "last",
        ]);
    });

    test("srv2: an invalid element ends the pending cue and is kept", () => {
        const content =
            '<timedtext><window id="1" t="0" op="define"/>' +
            '<text t="1000" d="2000" w="1">Hello</text><text t="1400" d="1600" w="1" append="1"> there</text>' +
            '<text d="5" append="1"> lost</text>' +
            '<text t="3000" d="2000" w="1">General</text><text w="1" t="3500" d="1500" append="1"> Kenobi</text>' +
            "</timedtext>";
        const units = extractCaptionUnits("srv2", content);
        expect(units).toEqual([
            {
                startMs: 1000,
                text: "Hello there",
                parts: [
                    { startMs: 1000, text: "Hello" },
                    { startMs: 1400, text: " there" },
                ],
            },
            { raw: '<text d="5" append="1"> lost</text>' },
            {
                startMs: 3000,
                text: "General Kenobi",
                parts: [
                    { startMs: 3000, text: "General" },
                    { startMs: 3500, text: " Kenobi" },
                ],
            },
        ]);
    });

    test("srv3: head elements sharing the <p prefix are ignored, a paragraph without time is kept", () => {
        const content =
            '<timedtext format="3"><head><pen id="1"/><wp id="1" ap="6"/></head><body>' +
            '<p t="1000" d="2000" w="1"><s>Hello</s><s t="400"> there</s></p>\n' +
            '<p d="2000">no time</p>\n' +
            '<p t="3000" d="2000">plain &amp; simple</p>\n' +
            "</body></timedtext>";
        const units = extractCaptionUnits("srv3", content);
        expect(units).toEqual([
            {
                startMs: 1000,
                text: "Hello there",
                parts: [
                    { startMs: 1000, text: "Hello" },
                    { startMs: 1400, text: " there" },
                ],
            },
            { raw: '<p d="2000">no time</p>' },
            { startMs: 3000, text: "plain & simple", parts: [{ startMs: 3000, text: "plain & simple" }] },
        ]);
    });

    test("ttml: a paragraph with an unreadable begin is kept, line breaks become spaces", () => {
        const content =
            '<tt><head><styling><style xml:id="s1"/></styling></head><body><div>' +
            '<p begin="00:00:01.500" end="00:00:03.000" style="s2">two<br />lines</p>\n' +
            '<p begin="soon" end="00:00:05.000">bad time</p>\n' +
            "</div></body></tt>";
        const units = extractCaptionUnits("ttml", content);
        expect(units.map((unit) => (isRawUnit(unit) ? unit : { startMs: unit.startMs, text: unit.text }))).toEqual([
            { startMs: 1500, text: "two lines" },
            { raw: '<p begin="soon" end="00:00:05.000">bad time</p>' },
        ]);
    });

    test("json3: an event of the wrong shape is kept as JSON, events without segs are skipped", () => {
        const content = JSON.stringify({
            events: [
                { tStartMs: 0, dDurationMs: 9000, id: 1 },
                { tStartMs: 1000, segs: [{ utf8: "Hello" }, { utf8: " there", tOffsetMs: 400 }] },
                { tStartMs: 2000, segs: [{ utf8: "\n" }] },
                { tStartMs: "3000", segs: [{ utf8: "bad time" }] },
                { segs: [{ utf8: "no time" }] },
            ],
        });
        expect(extractCaptionUnits("json3", content)).toEqual([
            {
                startMs: 1000,
                text: "Hello there",
                parts: [
                    { startMs: 1000, text: "Hello" },
                    { startMs: 1400, text: " there" },
                ],
            },
            { raw: '{"tStartMs":"3000","segs":[{"utf8":"bad time"}]}' },
            { raw: '{"segs":[{"utf8":"no time"}]}' },
        ]);
    });

    test("json3: content that is not JSON, or has no events, can't be segmented at all", () => {
        expect(() => extractCaptionUnits("json3", "<html>rate limited</html>")).toThrow();
        expect(() => extractCaptionUnits("json3", '{"wireMagic":"pb3"}')).toThrow();
    });
});
