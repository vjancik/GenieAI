import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import { buildLangchainMessage } from "../../../src/application/helpers/buildLangchainMessage.ts";
import { MEDIA_REQUEST_HEADERS } from "../../../src/application/helpers/mediaRequestHeaders.ts";
import type {
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
} from "../../../src/application/ports/chat/IChatClient.ts";
import { makeHeadResponse, spyFetch, spyFetchWith } from "../../helpers/fetchHelpers.ts";

const testLogger = pino({ level: "silent" });

const BASE_PARAMS = {
    guildId: "guild-1",
    channelId: "chan-1",
    discordMessageId: "msg-1",
    logger: testLogger,
};

const attachment: IChatClientMessageAttachment = {
    id: "att-1",
    url: "https://cdn.discord.com/img.png",
    proxyURL: "https://proxy/img.png",
    name: "img.png",
    size: 512,
    contentType: "image/png",
};

function makeEmbed(imageUrl: string): IChatClientMessageEmbed {
    return {
        type: "image",
        title: null,
        description: null,
        authorName: null,
        providerName: null,
        timestamp: null,
        footerText: null,
        fields: [],
        video: null,
        thumbnail: null,
        image: { url: imageUrl, proxyURL: null },
        componentTexts: [],
        componentMedia: [],
    };
}

describe("buildLangchainMessage", () => {
    let fetchSpy: ReturnType<typeof spyFetch>;

    beforeEach(() => {
        // Default: unused — individual tests install their own spy as needed.
        // We still track it so afterEach can always call mockRestore() safely.
        fetchSpy = spyFetch(makeHeadResponse("text/html"));
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    test("returns HumanMessage for role human", async () => {
        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "hello",
            attachments: [],
        });
        expect(result).toBeInstanceOf(HumanMessage);
    });

    test("returns AIMessage for role assistant", async () => {
        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "assistant",
            content: "hello",
            attachments: [],
        });
        expect(result).toBeInstanceOf(AIMessage);
    });

    test("no media: returns plain string content", async () => {
        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "plain text",
            attachments: [],
        });
        expect(result.content).toBe("plain text");
    });

    test("attachment: uses contentType from metadata, no HEAD request", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetchWith(() => {
            throw new Error("should not be called");
        });

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "here",
            attachments: [attachment],
        });

        const blocks = result.content as unknown[];
        const media = blocks.find((b) => (b as Record<string, unknown>).type === "media") as Record<string, unknown>;
        expect(media.mimeType).toBe("image/png");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("attachment: skips block and logs error when contentType is null", async () => {
        const errorSpy = mock();
        const logger = { ...testLogger, error: errorSpy };

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            logger,
            role: "human",
            content: "text",
            attachments: [{ ...attachment, contentType: null }],
        });

        // Block skipped — only the text block remains
        const blocks = result.content as unknown[];
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    test("embed media: uses Content-Type from HEAD response", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeHeadResponse("image/jpeg"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeEmbed("https://example.com/photo.jpg")],
        });

        const blocks = result.content as unknown[];
        expect(blocks).toHaveLength(1);
        const media = blocks[0] as Record<string, unknown>;
        expect(media.type).toBe("media");
        expect(media.mimeType).toBe("image/jpeg");
        // Token URL should be encoded, not the raw CDN URL
        expect(media.url).toBe("discord://guild-1/chan-1/msg-1/embed/0/image");
    });

    test("embed media: strips Content-Type parameters", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeHeadResponse("image/png; charset=utf-8"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        const blocks = result.content as unknown[];
        const media = blocks[0] as Record<string, unknown>;
        expect(media.mimeType).toBe("image/png");
    });

    test("embed media: skips block and warns when HEAD request throws", async () => {
        const warnSpy = mock();
        const logger = { ...testLogger, warn: warnSpy };
        fetchSpy.mockRestore();
        fetchSpy = spyFetchWith(() => {
            throw new Error("network error");
        });

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            logger,
            role: "human",
            content: "text",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        // Only the text block; embed block skipped
        const blocks = result.content as unknown[];
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test("embed media: skips block and warns when HEAD response has no Content-Type", async () => {
        const warnSpy = mock();
        const logger = { ...testLogger, warn: warnSpy };
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeHeadResponse(null));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            logger,
            role: "human",
            content: "text",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        const blocks = result.content as unknown[];
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test("embed media: skips block silently when Content-Type does not match key category", async () => {
        // image key but server returns video/mp4 — mismatch, block should be dropped without logging
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeHeadResponse("video/mp4"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "text",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        const blocks = result.content as unknown[];
        expect(blocks).toHaveLength(1);
        expect((blocks[0] as Record<string, unknown>).type).toBe("text");
    });

    test("embed media: HEAD is called with the raw CDN URL, not the token URL", async () => {
        fetchSpy.mockRestore();
        fetchSpy = spyFetch(makeHeadResponse("image/gif"));
        const cdnUrl = "https://example.com/anim.gif";

        await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeEmbed(cdnUrl)],
        });

        expect(fetchSpy).toHaveBeenCalledWith(cdnUrl, expect.objectContaining({ method: "HEAD" }));
    });

    test("embed media: probes with the Discordbot user agent", async () => {
        const requests: RequestInit[] = [];
        fetchSpy.mockRestore();
        fetchSpy = spyFetchWith((_url, init) => {
            if (init) requests.push(init);
            return makeHeadResponse("image/png");
        });

        await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        // A successful HEAD needs no GET fallback
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers).toEqual(MEDIA_REQUEST_HEADERS);
    });

    test("embed media: falls back to a one-byte ranged GET when HEAD is rejected", async () => {
        const requests: RequestInit[] = [];
        fetchSpy.mockRestore();
        fetchSpy = spyFetchWith((_url, init) => {
            if (init) requests.push(init);
            // The host answers HEAD with 405 Method Not Allowed and a JSON error body type
            return init?.method === "HEAD"
                ? new Response(null, { status: 405, headers: { "content-type": "application/json" } })
                : new Response("x", { status: 206, headers: { "content-type": "image/png" } });
        });

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        expect(requests.map((request) => request.method)).toEqual(["HEAD", "GET"]);
        expect(requests[1]?.headers).toEqual({ ...MEDIA_REQUEST_HEADERS, Range: "bytes=0-0" });
        const blocks = result.content as Record<string, unknown>[];
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.mimeType).toBe("image/png");
    });

    test("embed media: does not read the GET fallback body when the server ignores Range", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
                cancelled = true;
            },
        });
        fetchSpy.mockRestore();
        fetchSpy = spyFetchWith((_url, init) =>
            init?.method === "HEAD"
                ? new Response(null, { status: 405 })
                : new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
        );

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeEmbed("https://example.com/img.png")],
        });

        expect(cancelled).toBe(true);
        expect(result.content as unknown[]).toHaveLength(1);
    });
});

describe("buildLangchainMessage — embed component media", () => {
    let fetchSpy: ReturnType<typeof spyFetch>;

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    /** A component-based embed: no classic media slots, only component media. */
    function makeComponentsEmbed(media: IChatClientMessageEmbed["componentMedia"]): IChatClientMessageEmbed {
        return {
            ...makeEmbed(""),
            type: "components",
            image: null,
            componentTexts: ["caption"],
            componentMedia: media,
        };
    }

    test("emits a component media token block using Discord's content type, without probing", async () => {
        fetchSpy = spyFetch(makeHeadResponse("text/html"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "text",
            attachments: [],
            embeds: [
                makeComponentsEmbed([
                    { id: "777", url: "https://m.example/v", proxyURL: "https://proxy/v", contentType: "video/mp4" },
                ]),
            ],
        });

        const blocks = result.content as Record<string, unknown>[];
        expect(blocks[1]).toEqual({
            type: "media",
            mimeType: "video/mp4",
            url: "discord://guild-1/chan-1/msg-1/embed/0/componentMedia/777",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("uses the embed's index in the token and keeps gallery order", async () => {
        fetchSpy = spyFetch(makeHeadResponse("image/png"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [
                makeEmbed("https://example.com/classic.png"),
                makeComponentsEmbed([
                    { id: "1", url: "https://m.example/a", proxyURL: null, contentType: "image/jpeg" },
                    { id: "2", url: "https://m.example/b", proxyURL: null, contentType: "video/mp4" },
                ]),
            ],
        });

        const urls = (result.content as Record<string, unknown>[]).map((block) => block.url);
        expect(urls).toEqual([
            "discord://guild-1/chan-1/msg-1/embed/0/image",
            "discord://guild-1/chan-1/msg-1/embed/1/componentMedia/1",
            "discord://guild-1/chan-1/msg-1/embed/1/componentMedia/2",
        ]);
    });

    test("probes the URL when Discord supplies no content type", async () => {
        fetchSpy = spyFetch(makeHeadResponse("video/webm"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "",
            attachments: [],
            embeds: [makeComponentsEmbed([{ id: "5", url: "https://m.example/v", proxyURL: null, contentType: null }])],
        });

        expect(fetchSpy).toHaveBeenCalledWith("https://m.example/v", expect.objectContaining({ method: "HEAD" }));
        expect((result.content as Record<string, unknown>[])[0]?.mimeType).toBe("video/webm");
    });

    test("skips component media that is not image, video or audio", async () => {
        fetchSpy = spyFetch(makeHeadResponse("text/html"));

        const result = await buildLangchainMessage({
            ...BASE_PARAMS,
            role: "human",
            content: "text",
            attachments: [],
            embeds: [
                makeComponentsEmbed([
                    { id: "5", url: "https://m.example/p", proxyURL: null, contentType: "text/html" },
                ]),
            ],
        });

        const blocks = result.content as Record<string, unknown>[];
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe("text");
    });
});
