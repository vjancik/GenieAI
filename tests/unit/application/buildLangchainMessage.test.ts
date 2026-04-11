import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import pino from "pino";
import { buildLangchainMessage } from "../../../src/application/helpers/buildLangchainMessage.ts";
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

        expect(fetchSpy).toHaveBeenCalledWith(cdnUrl, { method: "HEAD", signal: expect.any(AbortSignal) });
    });
});
