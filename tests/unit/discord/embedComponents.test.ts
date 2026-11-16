import { describe, expect, test } from "bun:test";
import type { APIEmbed } from "discord.js";
import { parseEmbedComponents } from "../../../src/infrastructure/discord/embedComponents.ts";

/**
 * A "components" embed as Discord delivers it for an Instagram mirror link:
 * a container holding an author section (text + avatar thumbnail), a caption,
 * a media gallery with the video, and a footer section with a link button.
 */
export function makeComponentsEmbed(): APIEmbed {
    return {
        type: "components",
        url: "https://mirror.example/reel/abc/",
        components: [
            {
                type: 17,
                id: 1,
                components: [
                    {
                        type: 9,
                        id: 2,
                        components: [
                            { type: 10, id: 3, content: "**Author Name**\n[@author](https://example.com/author/)" },
                        ],
                        accessory: {
                            type: 11,
                            id: 4,
                            media: {
                                id: "1001",
                                url: "https://mirror.example/offload/abc/avatar?sig=a",
                                proxy_url: "https://images-ext-1.discordapp.net/external/avatar",
                                content_type: "image/jpeg",
                            },
                        },
                    },
                    { type: 10, id: 5, content: "The caption" },
                    {
                        type: 12,
                        id: 6,
                        items: [
                            {
                                media: {
                                    id: "1002",
                                    url: "https://mirror.example/offload/abc/1?sig=b",
                                    proxy_url: "https://images-ext-1.discordapp.net/external/video",
                                    content_type: "video/mp4",
                                },
                            },
                            { media: { id: "1003", url: "https://mirror.example/offload/abc/2?sig=c" } },
                        ],
                    },
                    {
                        type: 9,
                        id: 7,
                        components: [{ type: 10, id: 8, content: "-# Mirror · footer" }],
                        accessory: {
                            type: 2,
                            id: 9,
                            style: 5,
                            label: "Instagram",
                            url: "https://www.instagram.com/reel/abc/",
                        },
                    },
                ],
            },
        ],
    } as unknown as APIEmbed;
}

describe("parseEmbedComponents", () => {
    test("collects text displays and link buttons in display order", () => {
        expect(parseEmbedComponents(makeComponentsEmbed()).texts).toEqual([
            "**Author Name**\n[@author](https://example.com/author/)",
            "The caption",
            "-# Mirror · footer",
            "[Instagram](https://www.instagram.com/reel/abc/)",
        ]);
    });

    test("collects thumbnails and gallery items with their kind, ID and content type", () => {
        expect(parseEmbedComponents(makeComponentsEmbed()).media).toEqual([
            {
                id: "1001",
                url: "https://mirror.example/offload/abc/avatar?sig=a",
                proxyURL: "https://images-ext-1.discordapp.net/external/avatar",
                contentType: "image/jpeg",
                kind: "thumbnail",
            },
            {
                id: "1002",
                url: "https://mirror.example/offload/abc/1?sig=b",
                proxyURL: "https://images-ext-1.discordapp.net/external/video",
                contentType: "video/mp4",
                kind: "gallery",
            },
            // Optional fields absent from the payload come back as null
            {
                id: "1003",
                url: "https://mirror.example/offload/abc/2?sig=c",
                proxyURL: null,
                contentType: null,
                kind: "gallery",
            },
        ]);
    });

    test("returns empty lists for a classic embed without a component tree", () => {
        const embed: APIEmbed = { title: "Title", image: { url: "https://example.com/a.png" } };
        expect(parseEmbedComponents(embed)).toEqual({ texts: [], media: [] });
    });

    test("ignores malformed nodes instead of throwing", () => {
        const embed = {
            components: [
                null,
                "text",
                { type: 10, content: "   " },
                { type: 10, content: 42 },
                { type: 12, items: [null, { media: { url: "https://example.com/no-id.mp4" } }, { media: "nope" }] },
                { type: 11, media: { id: 5, url: "https://example.com/numeric-id.png" } },
                { type: 2, label: "Not a link button", custom_id: "x" },
                { type: 17, components: "not-an-array" },
            ],
        } as unknown as APIEmbed;
        expect(parseEmbedComponents(embed)).toEqual({ texts: [], media: [] });
    });

    test("labels a link button without a label generically", () => {
        const embed = { components: [{ type: 2, url: "https://example.com/post" }] } as unknown as APIEmbed;
        expect(parseEmbedComponents(embed).texts).toEqual(["[Link](https://example.com/post)"]);
    });
});
