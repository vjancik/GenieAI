import { describe, expect, test } from "bun:test";
import { parseVtt } from "../../../src/infrastructure/llm/tools/getVideoTranscriptionTool.ts";

/**
 * Tests for parseVtt are pure function tests — no mocking needed.
 * Integration-level tests for the yt-dlp shell execution are covered separately.
 */
describe("parseVtt", () => {
    test("strips the WEBVTT header line", () => {
        const vtt = "WEBVTT\n\nHello world";
        const result = parseVtt(vtt);
        expect(result).not.toContain("WEBVTT");
        expect(result).toContain("Hello world");
    });

    test("strips timestamp lines (-->) ", () => {
        const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there";
        const result = parseVtt(vtt);
        expect(result).not.toContain("-->");
        expect(result).not.toContain("00:00:01");
        expect(result).toContain("Hello there");
    });

    test("strips numeric cue identifiers", () => {
        const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello\n\n2\n00:00:04.000 --> 00:00:06.000\nWorld";
        const result = parseVtt(vtt);
        // Should not have isolated numeric lines
        expect(result).not.toMatch(/\b1\b/);
        expect(result).not.toMatch(/\b2\b/);
        expect(result).toContain("Hello");
        expect(result).toContain("World");
    });

    test("deduplicates consecutive identical lines (rolling captions)", () => {
        const vtt = [
            "WEBVTT",
            "",
            "00:00:01.000 --> 00:00:02.000",
            "Hello",
            "",
            "00:00:02.000 --> 00:00:03.000",
            "Hello",
            "",
            "00:00:03.000 --> 00:00:04.000",
            "World",
        ].join("\n");

        const result = parseVtt(vtt);
        // "Hello" should appear once, not twice
        const helloCount = result.split("Hello").length - 1;
        expect(helloCount).toBe(1);
        expect(result).toContain("World");
    });

    test("joins lines with spaces", () => {
        const vtt = [
            "WEBVTT",
            "",
            "00:00:01.000 --> 00:00:02.000",
            "First sentence.",
            "",
            "00:00:03.000 --> 00:00:04.000",
            "Second sentence.",
        ].join("\n");

        const result = parseVtt(vtt);
        expect(result).toBe("First sentence. Second sentence.");
    });

    test("handles empty VTT input gracefully", () => {
        expect(parseVtt("")).toBe("");
        expect(parseVtt("WEBVTT\n\n")).toBe("");
    });

    test("handles realistic VTT with mixed content", () => {
        const vtt = [
            "WEBVTT",
            "Kind: captions",
            "",
            "1",
            "00:00:00.000 --> 00:00:03.000",
            "Welcome to this video",
            "",
            "2",
            "00:00:03.000 --> 00:00:06.000",
            "Welcome to this video about programming",
            "",
            "3",
            "00:00:06.000 --> 00:00:09.000",
            "Today we will learn TypeScript",
        ].join("\n");

        const result = parseVtt(vtt);
        expect(result).not.toContain("WEBVTT");
        expect(result).not.toContain("-->");
        expect(result).toContain("Welcome to this video");
        expect(result).toContain("Today we will learn TypeScript");
    });
});
