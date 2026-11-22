import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import type { IMediaSource, OpenedMedia } from "../../../src/application/ports/IMediaSource.ts";
import { RoutingMediaSource } from "../../../src/application/services/RoutingMediaSource.ts";

const testLogger = pino({ level: "silent" });

function makeSource(name: string): IMediaSource & { open: ReturnType<typeof mock> } {
    const media: OpenedMedia = { stream: new ReadableStream(), mimeType: "image/png", byteLength: 1, name };
    return { open: mock(async () => media) };
}

describe("RoutingMediaSource.open", () => {
    test("opens discord tokens with the Discord source", async () => {
        const discord = makeSource("discord");
        const external = makeSource("external");
        const source = new RoutingMediaSource(discord, external, testLogger);

        const opened = await source.open("discord://g/c/m/a", "image/png");

        expect(opened).toMatchObject({ name: "discord" });
        expect(discord.open).toHaveBeenCalledWith("discord://g/c/m/a", "image/png");
        expect(external.open).not.toHaveBeenCalled();
    });

    test("opens web URLs with the external source", async () => {
        const discord = makeSource("discord");
        const external = makeSource("external");
        const source = new RoutingMediaSource(discord, external, testLogger);

        expect(await source.open("HTTPS://example.com/x.pdf")).toMatchObject({ name: "external" });
        expect(discord.open).not.toHaveBeenCalled();
    });

    test("returns null for a URL of an unknown kind", async () => {
        const source = new RoutingMediaSource(makeSource("discord"), makeSource("external"), testLogger);

        expect(await source.open("ftp://example.com/x.pdf")).toMatchObject({ unavailable: expect.any(String) });
    });
});
