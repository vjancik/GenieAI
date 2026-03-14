import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { YtDlpInfoJson } from "../../../src/infrastructure/llm/tools/getVideoTranscriptionTool.ts";
import { InfoJsonSchema, selectCaptionUrls } from "../../../src/infrastructure/llm/tools/getVideoTranscriptionTool.ts";

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
        expect(urls.every((u) => !u.includes("manifest.googlevideo.com"))).toBe(true);
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
