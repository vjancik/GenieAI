import { describe, expect, test } from "bun:test";
import { getBlockType } from "../../../src/infrastructure/attachments/contentBlockMapper.ts";

describe("getBlockType", () => {
    test("maps image/* MIME types to 'image'", () => {
        expect(getBlockType("image/jpeg")).toBe("image");
        expect(getBlockType("image/png")).toBe("image");
        expect(getBlockType("image/gif")).toBe("image");
        expect(getBlockType("image/webp")).toBe("image");
    });

    test("maps video/* MIME types to 'video'", () => {
        expect(getBlockType("video/mp4")).toBe("video");
        expect(getBlockType("video/webm")).toBe("video");
        expect(getBlockType("video/quicktime")).toBe("video");
    });

    test("maps audio/* MIME types to 'audio'", () => {
        expect(getBlockType("audio/mpeg")).toBe("audio");
        expect(getBlockType("audio/wav")).toBe("audio");
        expect(getBlockType("audio/ogg")).toBe("audio");
    });

    test("maps text/plain to 'text-plain'", () => {
        expect(getBlockType("text/plain")).toBe("text-plain");
    });

    test("maps text/html to 'file' (not text-plain)", () => {
        expect(getBlockType("text/html")).toBe("file");
    });

    test("maps unknown MIME types to 'file'", () => {
        expect(getBlockType("application/pdf")).toBe("file");
        expect(getBlockType("application/zip")).toBe("file");
        expect(getBlockType("application/octet-stream")).toBe("file");
    });

    test("is case-insensitive", () => {
        expect(getBlockType("IMAGE/JPEG")).toBe("image");
        expect(getBlockType("Video/MP4")).toBe("video");
        expect(getBlockType("AUDIO/WAV")).toBe("audio");
        expect(getBlockType("TEXT/PLAIN")).toBe("text-plain");
    });
});
