import { describe, expect, mock, test } from "bun:test";
import type { ContentBlock } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { buildAttachmentTokenUrl, buildEmbedTokenUrl } from "../../../src/application/helpers/discordTokenUrl.ts";
import type { IAttachmentDownloader } from "../../../src/application/ports/IAttachmentDownloader.ts";
import type { IDiscordMediaService } from "../../../src/application/ports/IDiscordMediaService.ts";
import { InlineMediaNormalizer } from "../../../src/application/services/InlineMediaNormalizer.ts";
import type { Logger } from "../../../src/application/types/Logger.ts";

const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
} as unknown as Logger;

const TOKEN_URL = buildAttachmentTokenUrl("guild1", "chan1", "msg1", "att1");
const EMBED_TOKEN_URL = buildEmbedTokenUrl("guild1", "chan1", "msg1", 0, "image");

const FAKE_ATTACHMENT = {
    id: "att1",
    url: "https://cdn.discordapp.com/attachments/chan1/att1/file.jpg",
    proxyURL: "https://media.discordapp.net/attachments/chan1/att1/file.jpg",
    name: "file.jpg",
    size: 100,
    contentType: "image/jpeg",
};

/** Builds a HumanMessage with a token URL media block. */
function humanWithToken(url: string, mimeType = "image/jpeg"): HumanMessage {
    return new HumanMessage([
        { type: "text", text: "look at this" } as ContentBlock,
        { type: "media", mimeType, url } as ContentBlock,
    ]);
}

/** Builds a HumanMessage with a resolved data media block. */
function humanWithData(data: string, mimeType = "image/jpeg"): HumanMessage {
    return new HumanMessage([
        { type: "text", text: "look at this" } as ContentBlock,
        { type: "media", mimeType, data } as ContentBlock,
    ]);
}

function makeNormalizer(mediaService: IDiscordMediaService, downloader: IAttachmentDownloader) {
    return new InlineMediaNormalizer(mediaService, downloader, noopLogger);
}

describe("InlineMediaNormalizer", () => {
    test("passes through messages with no token blocks unchanged", async () => {
        const msg = humanWithData("base64data");
        const mediaService = { fetchAttachment: mock(), fetchEmbedMedia: mock() } as unknown as IDiscordMediaService;
        const downloader = { download: mock() } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        expect(result).toHaveLength(1);
        expect(result[0]).toBe(msg); // exact same reference — no copy
        expect(mediaService.fetchAttachment).not.toHaveBeenCalled();
    });

    test("passes through non-HumanMessage messages unchanged", async () => {
        const ai = new AIMessage("hello");
        const mediaService = { fetchAttachment: mock(), fetchEmbedMedia: mock() } as unknown as IDiscordMediaService;
        const downloader = { download: mock() } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([ai]);

        expect(result[0]).toBe(ai);
    });

    test("resolves an attachment token block to a data block", async () => {
        const msg = humanWithToken(TOKEN_URL);
        const mediaService = {
            fetchAttachment: mock(() => Promise.resolve(FAKE_ATTACHMENT)),
            fetchEmbedMedia: mock(),
        } as unknown as IDiscordMediaService;
        const downloader = {
            download: mock(() => Promise.resolve({ data: "resolvedBase64", mimeType: "image/jpeg", name: "file.jpg" })),
        } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        expect(result).toHaveLength(1);
        const content = (result[0] as HumanMessage).content as ContentBlock[];
        // text block unchanged
        expect(content[0]).toEqual({ type: "text", text: "look at this" });
        // token block replaced with data block
        expect(content[1]).toEqual({ type: "media", mimeType: "image/jpeg", data: "resolvedBase64" });
        // fetchAttachment called with correct IDs
        expect(mediaService.fetchAttachment).toHaveBeenCalledWith("chan1", "msg1", "att1");
    });

    test("resolves an embed token block to a data block", async () => {
        const msg = humanWithToken(EMBED_TOKEN_URL, "image/png");
        const mediaService = {
            fetchAttachment: mock(),
            fetchEmbedMedia: mock(() => Promise.resolve(FAKE_ATTACHMENT)),
        } as unknown as IDiscordMediaService;
        const downloader = {
            download: mock(() => Promise.resolve({ data: "embedBase64", mimeType: "image/png", name: "embed.png" })),
        } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        const content = (result[0] as HumanMessage).content as ContentBlock[];
        expect(content[1]).toEqual({ type: "media", mimeType: "image/png", data: "embedBase64" });
        expect(mediaService.fetchEmbedMedia).toHaveBeenCalledWith("chan1", "msg1", 0, "image");
    });

    test("drops a token block when Discord media is no longer available", async () => {
        const msg = humanWithToken(TOKEN_URL);
        const mediaService = {
            fetchAttachment: mock(() => Promise.resolve(null)), // deleted
            fetchEmbedMedia: mock(),
        } as unknown as IDiscordMediaService;
        const downloader = { download: mock() } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        const content = (result[0] as HumanMessage).content as ContentBlock[];
        // Only the text block remains; media block was dropped
        expect(content).toHaveLength(1);
        expect(content[0]).toEqual({ type: "text", text: "look at this" });
    });

    test("drops a token block when download fails", async () => {
        const msg = humanWithToken(TOKEN_URL);
        const mediaService = {
            fetchAttachment: mock(() => Promise.resolve(FAKE_ATTACHMENT)),
            fetchEmbedMedia: mock(),
        } as unknown as IDiscordMediaService;
        const downloader = {
            download: mock(() => Promise.reject(new Error("network error"))),
        } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        const content = (result[0] as HumanMessage).content as ContentBlock[];
        expect(content).toHaveLength(1);
        expect(content[0]?.type).toBe("text");
    });

    test("drops a token block with an unparseable URL", async () => {
        const msg = new HumanMessage([
            { type: "text", text: "hi" } as ContentBlock,
            { type: "media", mimeType: "image/jpeg", url: "discord://only-two-parts" } as ContentBlock,
        ]);
        const mediaService = { fetchAttachment: mock(), fetchEmbedMedia: mock() } as unknown as IDiscordMediaService;
        const downloader = { download: mock() } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        const content = (result[0] as HumanMessage).content as ContentBlock[];
        expect(content).toHaveLength(1);
        expect(mediaService.fetchAttachment).not.toHaveBeenCalled();
    });

    test("resolves multiple token blocks in one message concurrently", async () => {
        const token2 = buildAttachmentTokenUrl("guild1", "chan1", "msg1", "att2");
        const msg = new HumanMessage([
            { type: "text", text: "two images" } as ContentBlock,
            { type: "media", mimeType: "image/jpeg", url: TOKEN_URL } as ContentBlock,
            { type: "media", mimeType: "image/png", url: token2 } as ContentBlock,
        ]);

        const mediaService = {
            fetchAttachment: mock((_channelId: string, _messageId: string, attachmentId: string) =>
                Promise.resolve({ ...FAKE_ATTACHMENT, id: attachmentId }),
            ),
            fetchEmbedMedia: mock(),
        } as unknown as IDiscordMediaService;
        const downloader = {
            download: mock((att: typeof FAKE_ATTACHMENT) =>
                Promise.resolve({ data: `data_${att.id}`, mimeType: "image/jpeg", name: att.name }),
            ),
        } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        const content = (result[0] as HumanMessage).content as ContentBlock[];
        expect(content).toHaveLength(3);
        expect((content[1] as unknown as { data: string }).data).toBe("data_att1");
        expect((content[2] as unknown as { data: string }).data).toBe("data_att2");
    });

    test("resolves tokens across multiple messages independently", async () => {
        const msg1 = humanWithToken(TOKEN_URL);
        const msg2 = new HumanMessage("no attachments here");

        const mediaService = {
            fetchAttachment: mock(() => Promise.resolve(FAKE_ATTACHMENT)),
            fetchEmbedMedia: mock(),
        } as unknown as IDiscordMediaService;
        const downloader = {
            download: mock(() => Promise.resolve({ data: "resolved", mimeType: "image/jpeg", name: "f.jpg" })),
        } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg1, msg2]);

        expect(result).toHaveLength(2);
        // msg1 resolved
        const content1 = (result[0] as HumanMessage).content as ContentBlock[];
        expect((content1[1] as unknown as { data: string }).data).toBe("resolved");
        // msg2 passed through unchanged
        expect(result[1]).toBe(msg2);
    });

    test("preserves already-resolved data blocks alongside token blocks", async () => {
        const msg = new HumanMessage([
            { type: "text", text: "mixed" } as ContentBlock,
            { type: "media", mimeType: "image/jpeg", data: "alreadyResolved" } as ContentBlock,
            { type: "media", mimeType: "image/png", url: TOKEN_URL } as ContentBlock,
        ]);

        const mediaService = {
            fetchAttachment: mock(() => Promise.resolve(FAKE_ATTACHMENT)),
            fetchEmbedMedia: mock(),
        } as unknown as IDiscordMediaService;
        const downloader = {
            download: mock(() => Promise.resolve({ data: "newlyResolved", mimeType: "image/png", name: "f.png" })),
        } as unknown as IAttachmentDownloader;

        const result = await makeNormalizer(mediaService, downloader).normalize([msg]);

        const content = (result[0] as HumanMessage).content as ContentBlock[];
        expect(content).toHaveLength(3);
        expect((content[1] as unknown as { data: string }).data).toBe("alreadyResolved");
        expect((content[2] as unknown as { data: string }).data).toBe("newlyResolved");
    });
});
