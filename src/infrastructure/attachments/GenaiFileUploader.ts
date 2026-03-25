import { FileState } from "@google/genai";
import * as Sentry from "@sentry/bun";
import { file as bunFile } from "bun";
import type { FileConfig } from "../../application/config/AppConfig.ts";
import type { IGeminiFileUploader, UploadedGeminiFile } from "../../application/ports/IGeminiFileUploader.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";
import { GoogleGenAIWithStreamingUpload } from "./GoogleGenAI.ts";

/**
 * Uploads files to the Gemini Files API using `GoogleGenAIWithStreamingUpload`.
 *
 * Each upload is assigned a caller-provided file name (e.g. `"files/<uuid>"`),
 * which makes names predictable and avoids UNIQUE constraint collisions on refresh.
 *
 * Files are streamed directly from disk without buffering into memory, using the
 * resumable upload protocol implemented in `GoogleGenAIWithStreamingUpload`.
 *
 * After upload, the file may be in PROCESSING state. This class polls
 * `ai.files.get()` every `geminiFileApi.pollIntervalMs` ms until the file reaches
 * ACTIVE state or until `geminiFileApi.maxPollWaitMs` elapses, at which point an
 * error is thrown.
 */
export class GenaiFileUploader implements IGeminiFileUploader {
    private readonly ai: GoogleGenAIWithStreamingUpload;
    private readonly pollIntervalMs: number;
    private readonly maxPollWaitMs: number;

    constructor(
        apiKey: string,
        readonly apiKeyId: string,
        private readonly logger: Logger,
        config: Pick<FileConfig, "geminiFileApi">,
    ) {
        this.ai = new GoogleGenAIWithStreamingUpload({ apiKey });
        this.pollIntervalMs = config.geminiFileApi.pollIntervalMs;
        this.maxPollWaitMs = config.geminiFileApi.maxPollWaitMs;
    }

    async upload(
        filePath: string,
        fileName: string,
        mimeType: string,
        displayName: string,
    ): Promise<UploadedGeminiFile> {
        return Sentry.startSpan(
            {
                name: "Upload file to Gemini Files API",
                op: "gemini.files.upload",
                attributes: {
                    "gemini.file_name": fileName,
                    "gemini.mime_type": mimeType,
                    "gemini.display_name": displayName,
                },
            },
            async (span) => {
                this.logger.debug({ filePath, fileName, mimeType, displayName }, "Uploading file to Gemini Files API");

                const bunFileHandle = bunFile(filePath);
                const byteLength = bunFileHandle.size;
                const stream = bunFileHandle.stream();

                let file = await this.ai.uploadStream(stream, {
                    name: fileName,
                    mimeType,
                    displayName,
                    byteLength,
                });

                this.logger.debug({ geminiFileName: file.name, state: file.state }, "File uploaded, checking state");

                // Poll until ACTIVE or FAILED (or timeout)
                const deadline = Date.now() + this.maxPollWaitMs;
                let pollCount = 0;
                while (file.state === FileState.PROCESSING) {
                    if (Date.now() >= deadline) {
                        throw new AppError(
                            "GEMINI_UPLOAD_FAILED",
                            `Timed out waiting for Gemini file "${fileName}" to become ACTIVE after ${this.maxPollWaitMs / 1000}s`,
                        );
                    }
                    await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
                    if (!file.name) {
                        throw new AppError(
                            "GEMINI_UPLOAD_FAILED",
                            `Gemini file "${fileName}" has no name during polling`,
                        );
                    }
                    file = await this.ai.files.get({ name: file.name });
                    pollCount++;
                    this.logger.debug({ geminiFileName: file.name, state: file.state }, "Polling Gemini file state");
                }

                span.setAttributes({
                    "gemini.poll_count": pollCount,
                    "gemini.final_state": file.state ?? "unknown",
                });

                if (file.state === FileState.FAILED) {
                    throw new AppError("GEMINI_UPLOAD_FAILED", `Gemini file "${fileName}" reached FAILED state`);
                }

                if (file.state !== FileState.ACTIVE) {
                    throw new AppError(
                        "GEMINI_UPLOAD_FAILED",
                        `Gemini file "${fileName}" reached unexpected state: ${file.state}`,
                    );
                }

                if (!file.uri) {
                    throw new AppError("GEMINI_UPLOAD_FAILED", `Gemini file "${fileName}" is ACTIVE but has no URI`);
                }

                if (!file.name) {
                    throw new AppError("GEMINI_UPLOAD_FAILED", `Gemini file "${fileName}" is ACTIVE but has no name`);
                }

                this.logger.info({ geminiFileName: file.name, geminiUrl: file.uri }, "Gemini file upload complete");

                return {
                    geminiFileName: file.name,
                    geminiUrl: file.uri,
                };
            },
        );
    }

    async deleteFile(geminiFileName: string): Promise<void> {
        try {
            await this.ai.files.delete({ name: geminiFileName });
            this.logger.debug({ geminiFileName }, "Deleted Gemini file");
        } catch (err) {
            // Silently ignore not-found errors — file may have already expired
            this.logger.debug({ geminiFileName, err }, "Failed to delete Gemini file (may already be expired)");
        }
    }
}
