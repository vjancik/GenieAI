import { describe, expect, spyOn, test } from "bun:test";
import pino from "pino";
import type { AppConfig } from "../../../src/application/config/AppConfig.ts";
import { MEDIA_REQUEST_HEADERS } from "../../../src/application/helpers/mediaRequestHeaders.ts";
import type { IChatClientMessageAttachment } from "../../../src/application/ports/chat/IChatClient.ts";
import { FetchStreamingAttachmentDownloader } from "../../../src/infrastructure/attachments/FetchStreamingAttachmentDownloader.ts";

const config = { file: { attachmentDownloader: { timeoutMs: 10_000 } } } as Pick<AppConfig, "file">;

/** Embed media: no Discord-provided content type, proxy URL as the primary target. */
const embedMedia: IChatClientMessageAttachment = {
    id: "https://example.com/reel/1",
    url: "https://images-ext-1.discordapp.net/external/sig/https/example.com/reel/1",
    proxyURL: "https://example.com/reel/1",
    name: "Embed-1-Video",
    size: 0,
    contentType: null,
};

describe("FetchStreamingAttachmentDownloader", () => {
    test("sends the Discordbot user agent on the primary and the fallback request", async () => {
        const globalFetch = spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 403 }))
            .mockResolvedValueOnce(new Response("video", { headers: { "content-type": "video/mp4" } }));
        const downloader = new FetchStreamingAttachmentDownloader(pino({ level: "silent" }), config);

        const result = await downloader.downloadStream(embedMedia, "video/mp4");

        expect(result.mimeType).toBe("video/mp4");
        expect(globalFetch.mock.calls.map((call) => call[0])).toEqual([embedMedia.url, embedMedia.proxyURL]);
        for (const call of globalFetch.mock.calls) {
            expect((call[1] as RequestInit).headers).toEqual({ ...MEDIA_REQUEST_HEADERS, Accept: "video/mp4" });
        }

        globalFetch.mockRestore();
    });
});
