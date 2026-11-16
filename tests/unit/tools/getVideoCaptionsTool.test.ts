import { describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { NoCaptionsError, ToolError } from "../../../src/domain/errors/AppError.ts";
import type {
    YtDlpInfoJson,
    YtDlpMetadataRunner,
    YtDlpRunResult,
} from "../../../src/infrastructure/llm/tools/getVideoCaptionsTool.ts";
import {
    fetchCaptionWithRetries,
    fetchMetadataWithRetries,
    InfoJsonSchema,
    isProxyRetryableYtDlpError,
    selectCaptionUrls,
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
const MANUAL_EN_VTT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&lang=en&fmt=vtt";
const AUTO_EN_SRT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&kind=asr&lang=en&fmt=srt";
const AUTO_EN_VTT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&kind=asr&lang=en&fmt=vtt";
const AUTO_DE_SRT =
    "https://www.youtube.com/api/timedtext?v=P-4pbFcERnk&ei=HpG1aePmKfGjw-AP9oyo8Aw&caps=asr&opi=112496729&xoaf=5&xowf=1&xospf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1773532046&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cxoaf&signature=95D329309046F015CF394E6CB958D1E3C22FB609.66CCA301E05012CDF5A94D00D66E4C08BEE25B4A&key=yt8&kind=asr&lang=en&fmt=srt&tlang=de";

describe("selectCaptionUrls", () => {
    test("returns empty array for info with no captions", () => {
        const info: YtDlpInfoJson = { id: "test", subtitles: {}, automatic_captions: {} };
        expect(selectCaptionUrls(info)).toEqual([]);
    });

    test("manual en srt is the first URL in the real fixture", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
        expect(urls[0]).toBe(MANUAL_EN_SRT);
    });

    test("manual en vtt comes before any auto captions", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
        const manualVttIdx = urls.indexOf(MANUAL_EN_VTT);
        const autoEnSrtIdx = urls.indexOf(AUTO_EN_SRT);
        expect(manualVttIdx).toBeGreaterThan(-1);
        expect(autoEnSrtIdx).toBeGreaterThan(-1);
        expect(manualVttIdx).toBeLessThan(autoEnSrtIdx);
    });

    test("auto en srt comes before auto en vtt", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
        const srtIdx = urls.indexOf(AUTO_EN_SRT);
        const vttIdx = urls.indexOf(AUTO_EN_VTT);
        expect(srtIdx).toBeGreaterThan(-1);
        expect(vttIdx).toBeGreaterThan(-1);
        expect(srtIdx).toBeLessThan(vttIdx);
    });

    test("auto slots are filled by en before de (de excluded when en fills all 5)", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
        // The fixture has 7 non-streaming en auto tracks (srt, vtt, ttml, srv1-3, json3),
        // so all 5 auto slots are taken by en — de should not appear at all
        expect(urls.indexOf(AUTO_EN_SRT)).toBeGreaterThan(-1);
        expect(urls.indexOf(AUTO_DE_SRT)).toBe(-1);
    });

    test("result contains no duplicate URLs", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
        expect(urls.length).toBe(new Set(urls).size);
    });

    test("never returns more than 10 URLs (5 manual + 5 auto)", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
        expect(urls.length).toBeLessThanOrEqual(10);
    });

    test("excludes HLS/m3u8 protocol entries", async () => {
        const info = await loadFixture();
        const urls = selectCaptionUrls(info);
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
        const urls = selectCaptionUrls(info);
        expect(urls[0]).toBe("https://example.com/manual-en.vtt");
        expect(urls[1]).toBe("https://example.com/auto-en.srt");
    });

    test("prefers en over de in automatic captions", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: {
                de: [{ ext: "srt", url: "https://example.com/auto-de.srt" }],
                en: [{ ext: "srt", url: "https://example.com/auto-en.srt" }],
            },
        };
        const urls = selectCaptionUrls(info);
        expect(urls[0]).toBe("https://example.com/auto-en.srt");
        expect(urls[1]).toBe("https://example.com/auto-de.srt");
    });

    test("prefers srt over vtt for same language and source type", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: {
                en: [
                    { ext: "vtt", url: "https://example.com/auto-en.vtt" },
                    { ext: "srt", url: "https://example.com/auto-en.srt" },
                ],
            },
        };
        const urls = selectCaptionUrls(info);
        expect(urls[0]).toBe("https://example.com/auto-en.srt");
        expect(urls[1]).toBe("https://example.com/auto-en.vtt");
    });

    test("unknown format comes after srt and vtt", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: {
                en: [
                    { ext: "json3", url: "https://example.com/auto-en.json3" },
                    { ext: "srt", url: "https://example.com/auto-en.srt" },
                    { ext: "vtt", url: "https://example.com/auto-en.vtt" },
                ],
            },
        };
        const urls = selectCaptionUrls(info);
        expect(urls[0]).toBe("https://example.com/auto-en.srt");
        expect(urls[1]).toBe("https://example.com/auto-en.vtt");
        expect(urls[2]).toBe("https://example.com/auto-en.json3");
    });

    test("unknown language comes after all priority languages", () => {
        const info: YtDlpInfoJson = {
            id: "test",
            subtitles: {},
            automatic_captions: {
                sw: [{ ext: "srt", url: "https://example.com/auto-sw.srt" }],
                de: [{ ext: "srt", url: "https://example.com/auto-de.srt" }],
            },
        };
        const urls = selectCaptionUrls(info);
        expect(urls[0]).toBe("https://example.com/auto-de.srt");
        expect(urls[1]).toBe("https://example.com/auto-sw.srt");
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
