import { describe, expect, test } from "bun:test";
import type { APIEmbed } from "discord.js";
import type { DiscordClient } from "../../../src/infrastructure/discord/DiscordClient.ts";
import { DiscordMediaService } from "../../../src/infrastructure/discord/DiscordMediaService.ts";
import { makeComponentsEmbed } from "./embedComponents.test.ts";

type FakeEmbed = { data: APIEmbed };

/** Builds a service over a fake client whose only message carries the given embeds. */
function makeService(embeds: FakeEmbed[], snapshotEmbeds: FakeEmbed[] = []): DiscordMediaService {
    const message = { embeds, messageSnapshots: new Map([["snap", { embeds: snapshotEmbeds }]]) };
    const channel = { isTextBased: () => true, messages: { fetch: async () => message } };
    return new DiscordMediaService({
        client: { channels: { fetch: async () => channel } },
    } as unknown as DiscordClient);
}

const classicEmbed: FakeEmbed = { data: { title: "classic" } };
const componentsEmbed: FakeEmbed = { data: makeComponentsEmbed() };

describe("DiscordMediaService.fetchEmbedComponentMedia", () => {
    test("returns the media item with the proxy URL as the primary download target", async () => {
        const media = await makeService([componentsEmbed]).fetchEmbedComponentMedia("chan", "msg", 0, "1002");

        expect(media).toEqual({
            id: "1002",
            url: "https://images-ext-1.discordapp.net/external/video",
            proxyURL: "https://mirror.example/offload/abc/1?sig=b",
            name: "Embed-1-Media-1002",
            size: 0,
            // Null so the downloader validates the response type instead of trusting it
            contentType: null,
        });
    });

    test("uses the original URL when the item has no proxy URL", async () => {
        const media = await makeService([componentsEmbed]).fetchEmbedComponentMedia("chan", "msg", 0, "1003");

        expect(media?.url).toBe("https://mirror.example/offload/abc/2?sig=c");
    });

    test("finds the item on another embed when the embed index no longer lines up", async () => {
        const media = await makeService([classicEmbed, componentsEmbed]).fetchEmbedComponentMedia(
            "chan",
            "msg",
            0,
            "1002",
        );

        expect(media?.id).toBe("1002");
    });

    test("finds the item on a forwarded message snapshot", async () => {
        const media = await makeService([], [componentsEmbed]).fetchEmbedComponentMedia("chan", "msg", 0, "1002");

        expect(media?.id).toBe("1002");
    });

    test("returns null when no embed carries the media item", async () => {
        expect(await makeService([componentsEmbed]).fetchEmbedComponentMedia("chan", "msg", 0, "9999")).toBeNull();
        expect(await makeService([classicEmbed]).fetchEmbedComponentMedia("chan", "msg", 5, "1002")).toBeNull();
    });

    test("returns null when the message cannot be fetched", async () => {
        const service = new DiscordMediaService({
            client: {
                channels: {
                    fetch: async () => {
                        throw new Error("Unknown Channel");
                    },
                },
            },
        } as unknown as DiscordClient);

        expect(await service.fetchEmbedComponentMedia("chan", "msg", 0, "1002")).toBeNull();
    });
});
