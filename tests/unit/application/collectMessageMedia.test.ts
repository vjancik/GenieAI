import { describe, expect, test } from "bun:test";
import { collectMessageMedia } from "../../../src/application/helpers/collectMessageMedia.ts";
import type {
    IChatClientMessage,
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
} from "../../../src/application/ports/chat/IChatClient.ts";

function attachment(id: string): IChatClientMessageAttachment {
    return {
        id,
        url: `https://cdn/${id}`,
        proxyURL: `https://proxy/${id}`,
        name: id,
        size: 1,
        contentType: "image/png",
    };
}

function embed(title: string): IChatClientMessageEmbed {
    return { title } as IChatClientMessageEmbed;
}

function message(parts: Partial<Pick<IChatClientMessage, "attachments" | "embeds" | "forwardedSnapshot">>) {
    return { attachments: [], embeds: [], forwardedSnapshot: null, ...parts } as unknown as IChatClientMessage;
}

describe("collectMessageMedia", () => {
    test("returns the message's own attachments and embeds when it is not a forward", () => {
        const msg = message({ attachments: [attachment("a")], embeds: [embed("e")] });

        const media = collectMessageMedia(msg);

        expect(media.attachments.map((a) => a.id)).toEqual(["a"]);
        expect(media.embeds.map((e) => e.title)).toEqual(["e"]);
    });

    test("includes the attachments and embeds of a forwarded snapshot", () => {
        const msg = message({
            forwardedSnapshot: {
                content: "fwd",
                cleanContent: "fwd",
                attachments: [attachment("snap-a")],
                embeds: [embed("snap-e0"), embed("snap-e1")],
            },
        });

        const media = collectMessageMedia(msg);

        expect(media.attachments.map((a) => a.id)).toEqual(["snap-a"]);
        // A forward has no embeds of its own, so snapshot embeds keep their snapshot index
        expect(media.embeds.map((e) => e.title)).toEqual(["snap-e0", "snap-e1"]);
    });

    test("lists the message's own items before the snapshot's", () => {
        const msg = message({
            attachments: [attachment("own")],
            embeds: [embed("own-e")],
            forwardedSnapshot: {
                content: null,
                cleanContent: null,
                attachments: [attachment("snap")],
                embeds: [embed("snap-e")],
            },
        });

        const media = collectMessageMedia(msg);

        expect(media.attachments.map((a) => a.id)).toEqual(["own", "snap"]);
        expect(media.embeds.map((e) => e.title)).toEqual(["own-e", "snap-e"]);
    });
});
