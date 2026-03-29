import { describe, expect, test } from "bun:test";
import {
    buildAttachmentTokenUrl,
    buildEmbedTokenUrl,
    isDiscordTokenUrl,
    parseDiscordTokenUrl,
} from "../../../src/application/helpers/discordTokenUrl.ts";

describe("buildAttachmentTokenUrl", () => {
    test("produces correct discord:// URL", () => {
        expect(buildAttachmentTokenUrl("guild1", "chan1", "msg1", "att1")).toBe("discord://guild1/chan1/msg1/att1");
    });

    test("handles @me DM guild sentinel", () => {
        const url = buildAttachmentTokenUrl("@me", "chan1", "msg1", "att1");
        expect(url).toBe("discord://@me/chan1/msg1/att1");
    });
});

describe("buildEmbedTokenUrl", () => {
    test("produces correct discord:// URL for embed image", () => {
        expect(buildEmbedTokenUrl("guild1", "chan1", "msg1", 0, "image")).toBe(
            "discord://guild1/chan1/msg1/embed/0/image",
        );
    });

    test("produces correct discord:// URL for embed video at index 2", () => {
        expect(buildEmbedTokenUrl("guild1", "chan1", "msg1", 2, "video")).toBe(
            "discord://guild1/chan1/msg1/embed/2/video",
        );
    });

    test("produces correct discord:// URL for thumbnail", () => {
        expect(buildEmbedTokenUrl("g", "c", "m", 1, "thumbnail")).toBe("discord://g/c/m/embed/1/thumbnail");
    });
});

describe("isDiscordTokenUrl", () => {
    test("returns true for discord:// URLs", () => {
        expect(isDiscordTokenUrl("discord://guild/chan/msg/att")).toBe(true);
    });

    test("returns false for https:// URLs", () => {
        expect(isDiscordTokenUrl("https://cdn.discordapp.com/attachments/123/456/file.png")).toBe(false);
    });

    test("returns false for empty string", () => {
        expect(isDiscordTokenUrl("")).toBe(false);
    });

    test("returns false for plain text", () => {
        expect(isDiscordTokenUrl("not a url")).toBe(false);
    });
});

describe("parseDiscordTokenUrl", () => {
    describe("attachment tokens", () => {
        test("parses a valid attachment token URL", () => {
            const result = parseDiscordTokenUrl("discord://guild1/chan1/msg1/att1");
            expect(result).toEqual({
                kind: "attachment",
                guildId: "guild1",
                channelId: "chan1",
                messageId: "msg1",
                attachmentId: "att1",
            });
        });

        test("round-trips through build → parse", () => {
            const url = buildAttachmentTokenUrl("123456789", "987654321", "111222333", "444555666");
            const result = parseDiscordTokenUrl(url);
            expect(result).toEqual({
                kind: "attachment",
                guildId: "123456789",
                channelId: "987654321",
                messageId: "111222333",
                attachmentId: "444555666",
            });
        });

        test("parses @me DM guild token", () => {
            const url = buildAttachmentTokenUrl("@me", "chan1", "msg1", "att1");
            const result = parseDiscordTokenUrl(url);
            expect(result).toEqual({
                kind: "attachment",
                guildId: "@me",
                channelId: "chan1",
                messageId: "msg1",
                attachmentId: "att1",
            });
        });
    });

    describe("embed tokens", () => {
        test("parses a valid embed image token URL", () => {
            const result = parseDiscordTokenUrl("discord://guild1/chan1/msg1/embed/0/image");
            expect(result).toEqual({
                kind: "embed",
                guildId: "guild1",
                channelId: "chan1",
                messageId: "msg1",
                embedIndex: 0,
                mediaKey: "image",
            });
        });

        test("parses embed video token with non-zero index", () => {
            const result = parseDiscordTokenUrl("discord://guild1/chan1/msg1/embed/3/video");
            expect(result).toEqual({
                kind: "embed",
                guildId: "guild1",
                channelId: "chan1",
                messageId: "msg1",
                embedIndex: 3,
                mediaKey: "video",
            });
        });

        test("parses thumbnail token", () => {
            const result = parseDiscordTokenUrl("discord://g/c/m/embed/1/thumbnail");
            expect(result).toEqual({
                kind: "embed",
                guildId: "g",
                channelId: "c",
                messageId: "m",
                embedIndex: 1,
                mediaKey: "thumbnail",
            });
        });

        test("round-trips through build → parse", () => {
            const url = buildEmbedTokenUrl("111", "222", "333", 2, "video");
            const result = parseDiscordTokenUrl(url);
            expect(result).toEqual({
                kind: "embed",
                guildId: "111",
                channelId: "222",
                messageId: "333",
                embedIndex: 2,
                mediaKey: "video",
            });
        });
    });

    describe("invalid inputs", () => {
        test("returns null for non-discord URL", () => {
            expect(parseDiscordTokenUrl("https://example.com/foo")).toBeNull();
        });

        test("returns null for empty string", () => {
            expect(parseDiscordTokenUrl("")).toBeNull();
        });

        test("returns null for discord:// URL with too few path segments", () => {
            expect(parseDiscordTokenUrl("discord://guild/chan")).toBeNull();
        });

        test("returns null for embed token with invalid mediaKey", () => {
            expect(parseDiscordTokenUrl("discord://g/c/m/embed/0/invalid")).toBeNull();
        });

        test("returns null for embed token with non-integer embedIndex", () => {
            expect(parseDiscordTokenUrl("discord://g/c/m/embed/abc/image")).toBeNull();
        });

        test("returns null for embed token with negative embedIndex", () => {
            expect(parseDiscordTokenUrl("discord://g/c/m/embed/-1/image")).toBeNull();
        });
    });
});
