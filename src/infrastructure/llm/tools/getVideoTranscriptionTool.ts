import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { Logger } from "../../../application/types/Logger.ts";
import { ToolError } from "../../../domain/errors/AppError.ts";

/**
 * Creates a LangChain tool that extracts transcriptions from video URLs using yt-dlp.
 *
 * For each URL, yt-dlp downloads auto-generated subtitles in VTT format to a temporary
 * directory. The VTT content is then parsed into clean plain text and returned.
 * Duplicate URLs are deduplicated, and individual failures are reported inline.
 *
 * @param logger - Injectable logger for testability
 */
export function createGetVideoTranscriptionTool(logger: Logger) {
    return tool(
        async ({ urls }) => {
            // Deduplicate URLs to avoid redundant yt-dlp invocations
            const unique = [...new Set(urls)];
            logger.debug({ urls: unique }, "Extracting video transcriptions");

            const results = await Promise.allSettled(
                unique.map((url) => extractTranscription(url, logger)),
            );

            return results
                .map((result, i) => {
                    if (result.status === "fulfilled") {
                        return result.value;
                    }
                    const err =
                        result.reason instanceof Error
                            ? result.reason
                            : new Error(String(result.reason));
                    logger.warn(
                        { url: unique[i], error: err.message },
                        "Failed to extract transcription",
                    );
                    return `## ${unique[i]}\n\nError: ${err.message}`;
                })
                .join("\n\n---\n\n");
        },
        {
            name: "get_video_transcription",
            description:
                "Extract transcriptions/subtitles from video URLs (YouTube, social media, etc.). " +
                "Use this when the user provides URLs pointing to video content they want summarized or analyzed.",
            schema: z.object({
                urls: z
                    .array(z.url())
                    .min(1)
                    .describe("Video URLs to transcribe"),
            }),
        },
    );
}

/**
 * Runs yt-dlp for a single video URL, downloads auto-subtitles to a temp dir,
 * reads the resulting VTT file, and returns formatted transcript text.
 *
 * @param url - The video URL to process
 * @param logger - Logger instance for progress tracking
 */
async function extractTranscription(
    url: string,
    logger: Logger,
): Promise<string> {
    const tmpDir = await mkdtemp(join(tmpdir(), "genie-yt-"));

    try {
        const proc = Bun.spawn(
            [
                "yt-dlp",
                "--skip-download",
                "--write-auto-sub",
                "--sub-lang",
                "en",
                "--sub-format",
                "vtt",
                "--no-warnings",
                "-o",
                join(tmpDir, "%(id)s"),
                url,
            ],
            { stderr: "pipe", stdout: "pipe" },
        );

        await proc.exited;

        if (proc.exitCode !== 0) {
            throw new ToolError(
                `yt-dlp exited with code ${proc.exitCode} for URL: ${url}`,
            );
        }

        // Locate the downloaded VTT file
        const files = await readdir(tmpDir);
        const vttFile = files.find((f) => f.endsWith(".vtt"));

        if (!vttFile) {
            throw new ToolError(
                `No subtitle file found for URL: ${url}. The video may not have auto-generated captions.`,
            );
        }

        const content = await readFile(join(tmpDir, vttFile), "utf-8");
        const transcript = parseVtt(content);

        logger.debug({ url, vttFile }, "Successfully extracted transcription");

        return `## ${url}\n\n${transcript}`;
    } finally {
        // Always clean up the temp directory
        await rm(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Parses WebVTT content into clean plain text.
 *
 * Removes the WEBVTT header, cue identifiers (numeric lines), timestamp lines
 * (lines containing "-->"), and deduplicates consecutive identical lines
 * (which appear frequently in auto-generated captions due to rolling display).
 *
 * @param vtt - Raw VTT file content
 * @returns Clean, deduplicated transcript text
 */
export function parseVtt(vtt: string): string {
    return (
        vtt
            .split("\n")
            .filter((line) => {
                const trimmed = line.trim();
                // Remove WEBVTT header
                if (trimmed.startsWith("WEBVTT")) return false;
                // Remove timestamp lines (e.g. "00:00:01.000 --> 00:00:03.000")
                if (trimmed.includes("-->")) return false;
                // Remove pure numeric cue identifiers
                if (/^\d+$/.test(trimmed)) return false;
                // Remove empty lines
                if (trimmed.length === 0) return false;
                return true;
            })
            .map((line) => line.trim())
            // Deduplicate consecutive identical lines (common in rolling captions)
            .filter((line, i, arr) => line !== arr[i - 1])
            .join(" ")
    );
}

export type GetVideoTranscriptionTool = ReturnType<
    typeof createGetVideoTranscriptionTool
>;
