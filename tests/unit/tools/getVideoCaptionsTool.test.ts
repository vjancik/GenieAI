import { describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { NoCaptionsError, ToolError, WebFetchError } from "../../../src/domain/errors/AppError.ts";
import type {
    CaptionDownloader,
    CaptionTrack,
    YtDlpInfoJson,
    YtDlpMetadataRunner,
    YtDlpRunResult,
} from "../../../src/infrastructure/llm/tools/getVideoCaptionsTool.ts";
import {
    fetchCaptionWithRetries,
    fetchMetadataWithRetries,
    InfoJsonSchema,
    isProxyRetryableYtDlpError,
    resolveCaptions,
    selectCaptionTracks,
    toVideoCaptionsError,
} from "../../../src/infrastructure/llm/tools/getVideoCaptionsTool.ts";

const testLogger = pino({ level: "silent" });
/** A deadline that never fires. */
const NO_DEADLINE = new AbortController().signal;

/** Real yt-dlp stderr as relayed from YouTube — note the typographic apostrophe (U+2019). */
const BOT_STDERR =
    "ERROR: [youtube] sXLpZdkS7u8: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.";
const PRIVATE_STDERR = "ERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video";
const PROXY_TIMEOUT_STDERR =
    "ERROR: [youtube] abc123: Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway'))";

const ok = (stdout = '{"id":"x"}'): YtDlpRunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): YtDlpRunResult => ({ stdout: "", stderr, exitCode: 1 });

/** Builds a runner whose metadata runs return the given results in order. */
function makeRunner(results: YtDlpRunResult[], updated = false) {
    const queue = [...results];
    const runMetadata = mock(async () => {
        const next = queue.shift();
        if (!next) throw new Error("runMetadata called more times than expected");
        return next;
    });
    const update = mock(async () => updated);
    const runner: YtDlpMetadataRunner = { runMetadata, update };
    return { runner, runMetadata, update };
}

/**
 * Load the real yt-dlp info JSON fixture for P-4pbFcERnk using the same
 * InfoJsonSchema.safeParse path as production, ensuring the fixture stays
 * valid against the schema.
 */
async function loadFixture(): Promise<YtDlpInfoJson> {
    const raw = await readFile(join(import.meta.dir, "data/yt-dlp-info-metadata.json"), "utf-8");
    const parsed = InfoJsonSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        throw new Error(`Fixture failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
}

// Known URLs from the fixture (verified by inspection)
const MANUAL_EN_SRT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&lang=en&fmt=srt";
const AUTO_EN_SRT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&kind=asr&lang=en&fmt=srt";
const AUTO_DE_SRT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&kind=asr&lang=en&fmt=srt&tlang=de";

/** Lists the formats of a track in the order they would be tried. */
const formatsOf = (track: CaptionTrack | undefined) => track?.candidates.map((candidate) => candidate.ext);

describe("selectCaptionTracks", () => {
    test("returns no tracks for info with no captions", () => {
        const info: YtDlpInfoJson = { id: "test", subtitles: {}, automatic_captions: {} };
        expect(selectCaptionTracks(info)).toEqual([]);
    });

    test("the manual en track comes first in the real fixture, with formats in preference order", async () => {
        const tracks = selectCaptionTracks(await loadFixture());
        expect(tracks[0]).toMatchObject({ isAuto: false, lang: "en" });
        expect(formatsOf(tracks[0])).toEqual(["srv3", "srt", "json3", "srv1", "ttml"]);
        expect(tracks[0]?.candidates[1]?.url).toBe(MANUAL_EN_SRT);
    });

    test("automatic tracks follow the manual ones in the real fixture", async () => {
        // The fixture's en-orig track lists the same URLs as en, so it is dropped as a duplicate
        const tracks = selectCaptionTracks(await loadFixture());
        expect(tracks.map((track) => `${track.isAuto ? "auto" : "manual"}:${track.lang}`)).toEqual([
            "manual:en",
            "auto:en",
        ]);
        expect(formatsOf(tracks[1])).toEqual(["srv3", "srt", "json3", "srv1", "ttml"]);
        expect(tracks[1]?.candidates[1]?.url).toBe(AUTO_EN_SRT);
    });

    test("excludes auto-translated tracks", async () => {
        const urls = selectCaptionTracks(await loadFixture()).flatMap((track) => track.candidates.map((c) => c.url));
        expect(urls).not.toContain(AUTO_DE_SRT);
        expect(urls.every((url) => !new URL(url).searchParams.has("tlang"))).toBe(true);
    });

    test("result contains no duplicate URLs", async () => {
        const urls = selectCaptionTracks(await loadFixture()).flatMap((track) => track.candidates.map((c) => c.url));
        expect(urls.length).toBe(new Set(urls).size);
    });

    test("excludes HLS/m3u8 protocol entries", async () => {
        const urls = selectCaptionTracks(await loadFixture()).flatMap((track) => track.candidates.map((c) => c.url));
        // HLS entries use protocol: "m3u8_native" and are served from manifest.googlevideo.com
        expect(urls.every((u: string) => !u.includes("manifest.googlevideo.com"))).toBe(true);
    });

    test("manual captions take priority even when auto captions exist for same language", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {
                en: [{ ext: "vtt", url: "https://example.com/manual-en.vtt" }],
            },
            automatic_captions: {
                en: [{ ext: "srt", url: "https://example.com/auto-en.srt" }],
            },
        };
        expect(selectCaptionTracks(info)).toEqual([
            { isAuto: false, lang: "en", candidates: [{ ext: "vtt", url: "https://example.com/manual-en.vtt" }] },
            { isAuto: true, lang: "en", candidates: [{ ext: "srt", url: "https://example.com/auto-en.srt" }] },
        ]);
    });

    test("prefers en over de, and priority languages over unknown ones", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: {
                sw: [{ ext: "srt", url: "https://example.com/auto-sw.srt" }],
                de: [{ ext: "srt", url: "https://example.com/auto-de.srt" }],
                en: [{ ext: "srt", url: "https://example.com/auto-en.srt" }],
            },
        };
        // Capped at two tracks per kind, so the unknown language is dropped
        expect(selectCaptionTracks(info).map((track) => track.lang)).toEqual(["en", "de"]);
    });

    test("orders formats srv3 > srt > json3 > srv1 > ttml > vtt > srv2, capped at five per track", () => {
        const exts = ["vtt", "srv2", "json3", "ttml", "srt", "srv1", "srv3"];
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: { en: exts.map((ext) => ({ ext, url: `https://example.com/auto-en.${ext}` })) },
        };
        expect(formatsOf(selectCaptionTracks(info)[0])).toEqual(["srv3", "srt", "json3", "srv1", "ttml"]);
    });

    test("formats without an extractor come after the known ones", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: {
                en: [
                    { ext: "sbv", url: "https://example.com/auto-en.sbv" },
                    { ext: "vtt", url: "https://example.com/auto-en.vtt" },
                    { ext: "srt", url: "https://example.com/auto-en.srt" },
                ],
            },
        };
        expect(formatsOf(selectCaptionTracks(info)[0])).toEqual(["srt", "vtt", "sbv"]);
    });

    test("a track left without fetchable formats is dropped", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: { en: [{ ext: "vtt", url: "https://example.com/manual-en.m3u8", protocol: "m3u8_native" }] },
            automatic_captions: {},
        };
        expect(selectCaptionTracks(info)).toEqual([]);
    });
});

describe("resolveCaptions", () => {
    const SRT = "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:05,000\nGeneral Kenobi.\n";
    const SRT_UNPARSEABLE = "Hello there.\n\nGeneral Kenobi.\n";
    const SRV3 =
        '<timedtext format="3"><body><p t="1000" d="2000">Hello there.</p><p t="3000" d="2000">General Kenobi.</p></body></timedtext>';
    const SRV3_EMPTY = '<timedtext format="3"><body></body></timedtext>';
    const SRV3_UNPARSEABLE = '<timedtext format="3"><body><p start="1">Hello there.</p></body></timedtext>';
    const JSON3_EMPTY = '{"events":[]}';
    const FORMATTED = "0:01 Hello there.\n0:03 General Kenobi.";

    /** Builds a track whose candidate URLs are `<kind>-<lang>.<ext>`. */
    function track(kind: "manual" | "auto", lang: string, exts: string[]): CaptionTrack {
        return {
            isAuto: kind === "auto",
            lang,
            candidates: exts.map((ext) => ({ ext, url: `${kind}-${lang}.${ext}` })),
        };
    }

    /** Builds a downloader serving the given contents by URL; unlisted URLs fail to download. */
    function makeDownloader(contents: Record<string, string>) {
        const downloaded: string[] = [];
        const download: CaptionDownloader = async (url) => {
            downloaded.push(url);
            return contents[url] ?? null;
        };
        return { download, downloaded };
    }

    test("formats the first format of the first track and stops there", async () => {
        const { download, downloaded } = makeDownloader({ "manual-en.srv3": SRV3, "manual-en.srt": SRT });
        const tracks = [track("manual", "en", ["srv3", "srt"]), track("auto", "en", ["srv3", "srt"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["manual-en.srv3"]);
    });

    test("moves to the next format when a download fails", async () => {
        const { download, downloaded } = makeDownloader({ "auto-en.srt": SRT });
        const tracks = [track("auto", "en", ["srv3", "srt", "json3"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["auto-en.srv3", "auto-en.srt"]);
    });

    test("moves to the next format when extraction fails", async () => {
        const { download, downloaded } = makeDownloader({ "auto-en.srv3": SRV3_UNPARSEABLE, "auto-en.srt": SRT });
        const tracks = [track("auto", "en", ["srv3", "srt", "json3"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["auto-en.srv3", "auto-en.srt"]);
    });

    test("forwards the raw srt file of an automatic track when its extraction fails", async () => {
        const { download, downloaded } = makeDownloader({
            "auto-en.srv3": SRV3_UNPARSEABLE,
            "auto-en.srt": SRT_UNPARSEABLE,
            "auto-en.json3": JSON3_EMPTY,
        });
        const tracks = [track("auto", "en", ["srv3", "srt", "json3"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({
            status: "ok",
            captions: SRT_UNPARSEABLE,
        });
        expect(downloaded).toEqual(["auto-en.srv3", "auto-en.srt"]);
    });

    test("never forwards the raw srt of an uploader-provided track", async () => {
        const { download, downloaded } = makeDownloader({
            "manual-en.srv3": SRV3_UNPARSEABLE,
            "manual-en.srt": SRT_UNPARSEABLE,
            "manual-en.json3": JSON3_EMPTY,
            "auto-en.srv3": SRV3,
        });
        const tracks = [track("manual", "en", ["srv3", "srt", "json3"]), track("auto", "en", ["srv3"])];
        // The unparseable srt counts as the track's second extraction failure, like any other format
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["manual-en.srv3", "manual-en.srt", "auto-en.srv3"]);
    });

    test("reports unparseable captions when only an uploader-provided track exists and it can't be parsed", async () => {
        const { download } = makeDownloader({ "manual-en.srv3": SRV3_UNPARSEABLE, "manual-en.srt": SRT_UNPARSEABLE });
        const tracks = [track("manual", "en", ["srv3", "srt", "json3"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({
            status: "unparseable",
            extractionFailures: 2,
        });
    });

    test("gives up on a track after two extraction failures and tries the next track", async () => {
        const { download, downloaded } = makeDownloader({
            "manual-en.srv3": SRV3_UNPARSEABLE,
            "manual-en.json3": "<html>not json</html>",
            "manual-en.srv1": "<transcript></transcript>",
            "auto-en.srv3": SRV3,
        });
        const tracks = [track("manual", "en", ["srv3", "srt", "json3", "srv1"]), track("auto", "en", ["srv3"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["manual-en.srv3", "manual-en.srt", "manual-en.json3", "auto-en.srv3"]);
    });

    test("reports unparseable captions when extraction fails everywhere and no srt can be had", async () => {
        const { download } = makeDownloader({
            "auto-en.srv3": SRV3_UNPARSEABLE,
            "auto-en.json3": "<html>not json</html>",
        });
        const tracks = [track("auto", "en", ["srv3", "srt", "json3", "srv1"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({
            status: "unparseable",
            extractionFailures: 2,
        });
    });

    test("skips an empty uploader-provided track after a single download", async () => {
        const { download, downloaded } = makeDownloader({
            "manual-en.srv3": SRV3_EMPTY,
            "manual-en.srt": "",
            "auto-en.srv3": SRV3,
        });
        const tracks = [track("manual", "en", ["srv3", "srt", "json3"]), track("auto", "en", ["srv3", "srt"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["manual-en.srv3", "auto-en.srv3"]);
    });

    test("confirms an empty automatic track with srt before any other format, then stops", async () => {
        const { download, downloaded } = makeDownloader({
            "auto-en.srv3": SRV3_EMPTY,
            "auto-en.json3": JSON3_EMPTY,
            "auto-en.srt": "\n",
            "auto-en-orig.srv3": SRV3,
        });
        const tracks = [track("auto", "en", ["srv3", "json3", "srt"]), track("auto", "en-orig", ["srv3"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "empty" });
        expect(downloaded).toEqual(["auto-en.srv3", "auto-en.srt"]);
    });

    test("uses the srt when it has the text an empty-looking format lacked", async () => {
        const { download, downloaded } = makeDownloader({ "auto-en.srv3": SRV3_EMPTY, "auto-en.srt": SRT });
        const tracks = [track("auto", "en", ["srv3", "srt"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "ok", captions: FORMATTED });
        expect(downloaded).toEqual(["auto-en.srv3", "auto-en.srt"]);
    });

    test("accepts a second empty format as confirmation when the srt can't be downloaded", async () => {
        const { download, downloaded } = makeDownloader({
            "auto-en.srv3": SRV3_EMPTY,
            "auto-en.json3": JSON3_EMPTY,
            "auto-en.srv1": "<transcript></transcript>",
        });
        const tracks = [track("auto", "en", ["srv3", "srt", "json3", "srv1"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "empty" });
        expect(downloaded).toEqual(["auto-en.srv3", "auto-en.srt", "auto-en.json3"]);
    });

    test("reports empty captions when the only tracks are empty uploader-provided ones", async () => {
        const { download } = makeDownloader({ "manual-en.srv3": SRV3_EMPTY, "manual-de.srt": "" });
        const tracks = [track("manual", "en", ["srv3", "srt"]), track("manual", "de", ["srt"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({ status: "empty" });
    });

    test("reports unavailable rather than empty when other downloads failed", async () => {
        const { download } = makeDownloader({ "manual-en.srv3": SRV3_EMPTY });
        const tracks = [track("manual", "en", ["srv3", "srt"]), track("auto", "en", ["srv3", "srt"])];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({
            status: "unavailable",
            downloadAttempts: 3,
        });
    });

    test("stops after ten downloads in total", async () => {
        const { download, downloaded } = makeDownloader({});
        const exts = ["srv3", "srt", "json3", "srv1", "ttml"];
        const tracks = [
            track("manual", "en", exts),
            track("manual", "de", exts),
            track("auto", "en", exts),
            track("auto", "de", exts),
        ];
        expect(await resolveCaptions(tracks, download, testLogger)).toEqual({
            status: "unavailable",
            downloadAttempts: 10,
        });
        expect(downloaded.length).toBe(10);
    });

    test("passes a format without an extractor through unchanged", async () => {
        const { download } = makeDownloader({ "manual-en.sbv": "0:00:01.000,0:00:03.000\nHello there." });
        expect(await resolveCaptions([track("manual", "en", ["sbv"])], download, testLogger)).toEqual({
            status: "ok",
            captions: "0:00:01.000,0:00:03.000\nHello there.",
        });
    });

    test("includes a few unparseable units verbatim instead of failing", async () => {
        const cues = Array.from({ length: 19 }, (_, i) => `<p t="${i * 1000}" d="1000">Line ${i}.</p>`);
        const content = `<timedtext format="3"><body>${cues.join("")}<p d="5">no time</p></body></timedtext>`;
        const { download } = makeDownloader({ "auto-en.srv3": content });
        const resolution = await resolveCaptions([track("auto", "en", ["srv3", "srt"])], download, testLogger);
        expect(resolution.status === "ok" && resolution.captions.split("\n").slice(-2)).toEqual([
            "0:18 Line 18.",
            '<p d="5">no time</p>',
        ]);
    });
});

describe("isProxyRetryableYtDlpError", () => {
    test("matches YouTube bot detection with a typographic apostrophe", () => {
        expect(isProxyRetryableYtDlpError(BOT_STDERR)).toBe(true);
    });

    test("matches YouTube bot detection with an ASCII apostrophe", () => {
        expect(isProxyRetryableYtDlpError("Sign in to confirm you're not a bot.")).toBe(true);
    });

    test.each([
        ["HTTP 429", "ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests"],
        ["proxy tunnel 5xx", PROXY_TIMEOUT_STDERR],
        ["read timeout", "ERROR: Unable to download webpage: The read operation timed out"],
        ["connection reset", "ERROR: [Errno 104] Connection reset by peer"],
        ["IP throttling", "ERROR: [youtube] abc: This content isn’t available, try again later."],
    ])("matches transient failure: %s", (_label, stderr) => {
        expect(isProxyRetryableYtDlpError(stderr)).toBe(true);
    });

    test.each([
        ["private video", PRIVATE_STDERR],
        ["age restriction", "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate"],
        ["proxy auth failure", "OSError('Tunnel connection failed: 407 Proxy Authentication Required')"],
        ["unsupported URL", "ERROR: Unsupported URL: https://example.com/"],
    ])("does not match non-transient failure: %s", (_label, stderr) => {
        expect(isProxyRetryableYtDlpError(stderr)).toBe(false);
    });
});

describe("fetchMetadataWithRetries", () => {
    test("returns stdout on first success without retrying or updating", async () => {
        const { runner, runMetadata, update } = makeRunner([ok("first")]);
        expect(await fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, true, 5)).toBe("first");
        expect(runMetadata).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
    });

    test("retries bot detection through the proxy until success", async () => {
        const { runner, runMetadata, update } = makeRunner([fail(BOT_STDERR), fail(BOT_STDERR), ok("third")]);
        expect(await fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, true, 5)).toBe("third");
        expect(runMetadata).toHaveBeenCalledTimes(3);
        expect(update).not.toHaveBeenCalled();
    });

    test("retries a transient proxy error on the first attempt", async () => {
        const { runner, runMetadata } = makeRunner([fail(PROXY_TIMEOUT_STDERR), ok("second")]);
        expect(await fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, true, 5)).toBe("second");
        expect(runMetadata).toHaveBeenCalledTimes(2);
    });

    test("stops after proxyRetries and throws without updating", async () => {
        const { runner, runMetadata, update } = makeRunner(Array.from({ length: 4 }, () => fail(BOT_STDERR)));
        await expect(fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, true, 3)).rejects.toBeInstanceOf(
            ToolError,
        );
        expect(runMetadata).toHaveBeenCalledTimes(4);
        expect(update).not.toHaveBeenCalled();
    });

    test("stops retrying early once the failure becomes non-transient, then tries an update", async () => {
        const { runner, runMetadata, update } = makeRunner([fail(BOT_STDERR), fail(PRIVATE_STDERR)]);
        await expect(fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, true, 10)).rejects.toThrow(
            "Private video",
        );
        expect(runMetadata).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledTimes(1);
    });

    test("does not retry transient failures without a proxy", async () => {
        const { runner, runMetadata, update } = makeRunner([fail(BOT_STDERR)]);
        await expect(fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, false, 5)).rejects.toBeInstanceOf(
            ToolError,
        );
        expect(runMetadata).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
    });

    test("retries once after a successful update for non-transient failures", async () => {
        const { runner, runMetadata, update } = makeRunner([fail(PRIVATE_STDERR), ok("updated")], true);
        expect(await fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, false, 5)).toBe("updated");
        expect(runMetadata).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledTimes(1);
    });

    test("throws without re-running when yt-dlp is already up to date", async () => {
        const { runner, runMetadata, update } = makeRunner([fail(PRIVATE_STDERR)], false);
        await expect(fetchMetadataWithRetries("u", testLogger, runner, NO_DEADLINE, true, 5)).rejects.toThrow(
            "Private video",
        );
        expect(runMetadata).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
    });
});

describe("fetchCaptionWithRetries", () => {
    test("returns the first non-429 response without retrying", async () => {
        const request = mock(async () => new Response("captions", { status: 200 }));
        const response = await fetchCaptionWithRetries("c", request, 5, testLogger, NO_DEADLINE);
        expect(await response?.text()).toBe("captions");
        expect(request).toHaveBeenCalledTimes(1);
    });

    test("retries when the request throws", async () => {
        let calls = 0;
        const request = mock(async () => {
            calls++;
            if (calls < 3) throw new Error("proxy timeout");
            return new Response("captions", { status: 200 });
        });
        const response = await fetchCaptionWithRetries("c", request, 5, testLogger, NO_DEADLINE);
        expect(response?.ok).toBe(true);
        expect(request).toHaveBeenCalledTimes(3);
    });

    test("retries on 429 and returns the last 429 once retries are exhausted", async () => {
        const request = mock(async () => new Response(null, { status: 429 }));
        const response = await fetchCaptionWithRetries("c", request, 2, testLogger, NO_DEADLINE);
        expect(response?.status).toBe(429);
        expect(request).toHaveBeenCalledTimes(3);
    });

    test("does not retry non-429 error responses", async () => {
        const request = mock(async () => new Response(null, { status: 403 }));
        const response = await fetchCaptionWithRetries("c", request, 5, testLogger, NO_DEADLINE);
        expect(response?.status).toBe(403);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test("returns null when every attempt throws", async () => {
        const request = mock(async (): Promise<Response> => {
            throw new Error("connection reset");
        });
        expect(await fetchCaptionWithRetries("c", request, 2, testLogger, NO_DEADLINE)).toBeNull();
        expect(request).toHaveBeenCalledTimes(3);
    });

    test("makes a single attempt when retries is 0", async () => {
        const request = mock(async () => new Response(null, { status: 429 }));
        await fetchCaptionWithRetries("c", request, 0, testLogger, NO_DEADLINE);
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe("ytDlp.timeoutMs deadline", () => {
    /** Returns an already-aborted deadline signal. */
    const expiredDeadline = () => AbortSignal.abort(new DOMException("deadline", "TimeoutError"));

    test("metadata fetch throws without running yt-dlp when the deadline has passed", async () => {
        const { runner, runMetadata } = makeRunner([ok()]);
        await expect(fetchMetadataWithRetries("u", testLogger, runner, expiredDeadline(), true, 5)).rejects.toThrow(
            "timeoutMs",
        );
        expect(runMetadata).not.toHaveBeenCalled();
    });

    test("metadata retries stop once the deadline fires mid-retry", async () => {
        const controller = new AbortController();
        let calls = 0;
        const runner: YtDlpMetadataRunner = {
            runMetadata: mock(async () => {
                calls++;
                // Deadline fires during the second attempt, which the killed process reports as a failure
                if (calls === 2) controller.abort();
                return fail(BOT_STDERR);
            }),
            update: mock(async () => false),
        };
        await expect(fetchMetadataWithRetries("u", testLogger, runner, controller.signal, true, 10)).rejects.toThrow(
            "timeoutMs",
        );
        expect(calls).toBe(2);
        expect(runner.update).not.toHaveBeenCalled();
    });

    test("a deadline-killed process is not treated as a non-transient failure needing an update", async () => {
        const controller = new AbortController();
        const runner: YtDlpMetadataRunner = {
            runMetadata: mock(async () => {
                controller.abort();
                return fail("");
            }),
            update: mock(async () => false),
        };
        await expect(fetchMetadataWithRetries("u", testLogger, runner, controller.signal, true, 5)).rejects.toThrow(
            "timeoutMs",
        );
        expect(runner.update).not.toHaveBeenCalled();
    });

    test("caption fetch throws without requesting when the deadline has passed", async () => {
        const request = mock(async () => new Response("captions"));
        await expect(fetchCaptionWithRetries("c", request, 5, testLogger, expiredDeadline())).rejects.toThrow(
            "timeoutMs",
        );
        expect(request).not.toHaveBeenCalled();
    });

    test("caption retries stop when a request is aborted by the deadline", async () => {
        const controller = new AbortController();
        const request = mock(async (): Promise<Response> => {
            controller.abort();
            throw new DOMException("aborted", "AbortError");
        });
        await expect(fetchCaptionWithRetries("c", request, 5, testLogger, controller.signal)).rejects.toThrow(
            "timeoutMs",
        );
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe("toVideoCaptionsError", () => {
    test("carries the reason of a URL refused by the external content policy", () => {
        const err = new WebFetchError("insecure-url", "http://v: only HTTPS URLs are allowed — this is a fixed policy");
        expect(toVideoCaptionsError("http://v", err)).toEqual({
            url: "http://v",
            error: "http://v: only HTTPS URLs are allowed — this is a fixed policy",
            reason: "insecure-url",
        });
    });

    test("forwards a NoCaptionsError message with title and author", () => {
        const err = new NoCaptionsError("This video has no captions or subtitles available", "My Video", "My Channel");
        expect(toVideoCaptionsError("https://v", err)).toEqual({
            url: "https://v",
            error: "This video has no captions or subtitles available",
            title: "My Video",
            author: "My Channel",
        });
    });

    test("omits missing title and author from a NoCaptionsError entry", () => {
        const err = new NoCaptionsError("This video has no captions or subtitles available", null, null);
        expect(toVideoCaptionsError("https://v", err)).toEqual({
            url: "https://v",
            error: "This video has no captions or subtitles available",
        });
    });

    test("reports other failures generically without leaking details", () => {
        const err = new ToolError(`yt-dlp failed (exit 1): ${BOT_STDERR}`);
        expect(toVideoCaptionsError("https://v", err)).toEqual({
            url: "https://v",
            error: "Failed to retrieve captions for https://v",
        });
    });

    test("handles non-Error rejection values", () => {
        expect(toVideoCaptionsError("https://v", "boom")).toEqual({
            url: "https://v",
            error: "Failed to retrieve captions for https://v",
        });
    });
});
