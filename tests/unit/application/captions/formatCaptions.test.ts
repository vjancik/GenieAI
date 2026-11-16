import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { file } from "bun";
import {
    formatCaptions,
    formatTimestamp,
    MAX_RAW_UNIT_RATIO,
} from "../../../../src/application/formatters/captions/formatCaptions.ts";

/** Loads a fixture: the first 40 seconds of a real YouTube video's English track in the given format. */
function loadFixture(kind: "manual" | "auto", format: string): Promise<string> {
    return file(join(import.meta.dir, "data", `${kind}.en.${format}`)).text();
}

/** Builds an srt file of `count` one-sentence cues, two seconds apart. */
function buildSrt(count: number): string {
    return Array.from({ length: count }, (_, i) => {
        const clock = (seconds: number) => `00:00:${String(seconds).padStart(2, "0")},000`;
        return `${i + 1}\n${clock(i * 2)} --> ${clock(i * 2 + 2)}\nSentence number ${i + 1}.`;
    }).join("\n\n");
}

describe("formatTimestamp", () => {
    test("uses M:SS below one hour and H:MM:SS from one hour on", () => {
        expect(formatTimestamp(0)).toBe("0:00");
        expect(formatTimestamp(65_000)).toBe("1:05");
        expect(formatTimestamp(754_000)).toBe("12:34");
        expect(formatTimestamp(3_600_000)).toBe("1:00:00");
        expect(formatTimestamp(3_725_000)).toBe("1:02:05");
        expect(formatTimestamp(36_000_000)).toBe("10:00:00");
    });

    test("truncates sub-second information instead of rounding", () => {
        expect(formatTimestamp(5_999)).toBe("0:05");
        expect(formatTimestamp(59_999)).toBe("0:59");
    });
});

describe("formatCaptions on real tracks", () => {
    const MANUAL_TRANSCRIPT = [
        "0:00 - This might be the most ambitious long shot precision experiment that I've ever seen.",
        "0:06 Scientists have put one atomic clock down in Boulder, Colorado, and one up in this observatory 4,000 meters above sea level, and they're going to try and measure the difference in time dilation according to general relativity.",
        "0:18 Because up here, time itself should be passing faster relative to down in Boulder.",
        "0:23 - If you go into a science center, often they will explain gravity as the bending of space time, and what they will have is a little funnel where the particle goes around the funnel, and that's meant to give you an impression of why the earth goes around the sun.",
        "0:37 But that's not actually what happens.",
        "0:39 It's not as much that space is curving, it's",
    ].join("\n");

    /** Automatic transcript as `[exact, line-level]` timestamps per sentence. */
    const AUTO_SENTENCES: [string, string, string][] = [
        ["0:00", "0:00", "This might be the most ambitious long shot precision experiment that I've ever seen."],
        [
            "0:06",
            "0:05",
            "Scientists have put one atomic clock down in Boulder, Colorado and one up in this observatory 4,000 m above sea level and they're going to try and measure the difference in time dilation according to general relativity.",
        ],
        ["0:17", "0:17", "Because up here, time [music] itself should be passing faster relative to down in Boulder."],
        [
            "0:24",
            "0:24",
            ">> If you go into a science center, often they will explain gravity as the bending of space-time and what they will have is a little funnel here the particle goes [music] around the funnel and that's meant to give you an impression of why the Earth goes around the Sun.",
        ],
        ["0:37", "0:35", "But that's not actually what happens."],
        ["0:39", "0:37", "It's not as much that space is curving, it's"],
    ];

    for (const format of ["srv3", "srt", "json3", "srv1", "ttml", "vtt", "srv2"]) {
        test(`uploader-provided ${format} becomes one line per sentence`, async () => {
            expect(formatCaptions(format, await loadFixture("manual", format))).toEqual({
                status: "ok",
                text: MANUAL_TRANSCRIPT,
                cueCount: 17,
                rawUnitCount: 0,
                sentenceGrouped: true,
            });
        });
    }

    for (const format of ["srv3", "json3", "vtt", "srv2"]) {
        test(`automatic ${format} labels sentences with the exact time of their first word`, async () => {
            const result = formatCaptions(format, await loadFixture("auto", format));
            expect(result).toMatchObject({ status: "ok", cueCount: 20, rawUnitCount: 0, sentenceGrouped: true });
            expect(result.status === "ok" && result.text).toBe(
                AUTO_SENTENCES.map(([exact, , text]) => `${exact} ${text}`).join("\n"),
            );
        });
    }

    for (const format of ["srt", "srv1", "ttml"]) {
        test(`automatic ${format} labels sentences with the start of the cue they begin in`, async () => {
            const result = formatCaptions(format, await loadFixture("auto", format));
            expect(result.status === "ok" && result.text).toBe(
                AUTO_SENTENCES.map(([, lineLevel, text]) => `${lineLevel} ${text}`).join("\n"),
            );
        });
    }
});

describe("formatCaptions outcomes", () => {
    test("a file without cues is empty", () => {
        expect(formatCaptions("srt", "")).toEqual({ status: "empty" });
        expect(formatCaptions("srt", "\n\n")).toEqual({ status: "empty" });
        expect(formatCaptions("vtt", "WEBVTT\n\n")).toEqual({ status: "empty" });
        expect(formatCaptions("srv3", '<timedtext format="3"><body></body></timedtext>')).toEqual({ status: "empty" });
        expect(formatCaptions("json3", '{"events":[]}')).toEqual({ status: "empty" });
    });

    test("an unsupported format fails", () => {
        expect(formatCaptions("sbv", "0:00:01.000,0:00:03.000\nHello")).toEqual({
            status: "failed",
            reason: 'unsupported caption format "sbv"',
        });
    });

    test("a file that can't be segmented at all fails", () => {
        expect(formatCaptions("json3", "<html>rate limited</html>").status).toBe("failed");
    });

    test("a file where every unit fails to parse is a failure, not empty", () => {
        const content = '<timedtext format="3"><body><p start="1">a</p><p start="2">b</p></body></timedtext>';
        expect(formatCaptions("srv3", content)).toEqual({
            status: "failed",
            reason: "2 of 2 units could not be parsed",
        });
    });

    test("unparseable units up to the allowed share are included verbatim, in place", () => {
        // 1 raw unit among 20 units is exactly the allowed 5%
        const blocks = buildSrt(19).split("\n\n");
        blocks.splice(10, 0, "stray text without a timing line");
        const result = formatCaptions("srt", blocks.join("\n\n"));
        expect(1 / 20).toBe(MAX_RAW_UNIT_RATIO);
        expect(result).toMatchObject({ status: "ok", cueCount: 19, rawUnitCount: 1, sentenceGrouped: true });
        const lines = result.status === "ok" ? result.text.split("\n") : [];
        expect(lines.length).toBe(20);
        expect(lines.slice(9, 12)).toEqual([
            "0:18 Sentence number 10.",
            "stray text without a timing line",
            "0:20 Sentence number 11.",
        ]);
    });

    test("more unparseable units than the allowed share is a failure", () => {
        const blocks = buildSrt(18).split("\n\n");
        blocks.splice(10, 0, "stray text without a timing line");
        expect(formatCaptions("srt", blocks.join("\n\n"))).toEqual({
            status: "failed",
            reason: "1 of 19 units could not be parsed",
        });
    });

    test("a track without punctuation keeps one line per cue", () => {
        const content = Array.from(
            { length: 12 },
            (_, i) =>
                `${i + 1}\n00:00:${String(i * 4).padStart(2, "0")},000 --> 00:01:00,000\njust words flowing on without any stop`,
        ).join("\n\n");
        const result = formatCaptions("srt", content);
        expect(result).toMatchObject({ status: "ok", cueCount: 12, sentenceGrouped: false });
        expect(result.status === "ok" && result.text.split("\n").slice(0, 2)).toEqual([
            "0:00 just words flowing on without any stop",
            "0:04 just words flowing on without any stop",
        ]);
    });
});
