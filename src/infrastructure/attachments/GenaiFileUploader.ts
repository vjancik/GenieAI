import { FileState, GoogleGenAI } from "@google/genai";
import type {
    IGeminiFileUploader,
    UploadedGeminiFile,
} from "../../application/ports/IGeminiFileUploader.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";

/** How long to wait between status polls when a file is in PROCESSING state (ms). */
const POLL_INTERVAL_MS = 5_000;

/** Maximum total time to wait for a file to reach ACTIVE state (ms). */
const MAX_POLL_WAIT_MS = 120_000;

/**
 * Uploads files to the Gemini Files API using `@google/genai`.
 *
 * Each upload is assigned a caller-provided file name (e.g. `"files/<uuid>"`),
 * which makes names predictable and avoids UNIQUE constraint collisions on refresh.
 *
 * After upload, the file may be in PROCESSING state. This class polls
 * `ai.files.get()` every {@link POLL_INTERVAL_MS} ms until the file reaches
 * ACTIVE state or until {@link MAX_POLL_WAIT_MS} elapses, at which point an
 * error is thrown.
 */
export class GenaiFileUploader implements IGeminiFileUploader {
    private readonly ai: GoogleGenAI;

    constructor(
        apiKey: string,
        private readonly logger: Logger,
    ) {
        this.ai = new GoogleGenAI({ apiKey });
    }

    async upload(
        filePath: string,
        fileName: string,
        mimeType: string,
        displayName: string,
    ): Promise<UploadedGeminiFile> {
        this.logger.debug(
            { filePath, fileName, mimeType, displayName },
            "Uploading file to Gemini Files API",
        );

        let file = await this.ai.files.upload({
            file: filePath,
            config: { name: fileName, mimeType, displayName },
        });

        this.logger.debug(
            { geminiFileName: file.name, state: file.state },
            "File uploaded, checking state",
        );

        // Poll until ACTIVE or FAILED (or timeout)
        const deadline = Date.now() + MAX_POLL_WAIT_MS;
        while (file.state === FileState.PROCESSING) {
            if (Date.now() >= deadline) {
                throw new AppError(
                    "GEMINI_UPLOAD_FAILED",
                    `Timed out waiting for Gemini file "${fileName}" to become ACTIVE after ${MAX_POLL_WAIT_MS / 1000}s`,
                );
            }
            await new Promise<void>((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS),
            );
            if (!file.name) {
                throw new AppError(
                    "GEMINI_UPLOAD_FAILED",
                    `Gemini file "${fileName}" has no name during polling`,
                );
            }
            file = await this.ai.files.get({ name: file.name });
            this.logger.debug(
                { geminiFileName: file.name, state: file.state },
                "Polling Gemini file state",
            );
        }

        if (file.state === FileState.FAILED) {
            throw new AppError(
                "GEMINI_UPLOAD_FAILED",
                `Gemini file "${fileName}" reached FAILED state`,
            );
        }

        if (file.state !== FileState.ACTIVE) {
            throw new AppError(
                "GEMINI_UPLOAD_FAILED",
                `Gemini file "${fileName}" reached unexpected state: ${file.state}`,
            );
        }

        if (!file.uri) {
            throw new AppError(
                "GEMINI_UPLOAD_FAILED",
                `Gemini file "${fileName}" is ACTIVE but has no URI`,
            );
        }

        if (!file.name) {
            throw new AppError(
                "GEMINI_UPLOAD_FAILED",
                `Gemini file "${fileName}" is ACTIVE but has no name`,
            );
        }

        this.logger.info(
            { geminiFileName: file.name, geminiUrl: file.uri },
            "Gemini file upload complete",
        );

        return {
            geminiFileName: file.name,
            geminiUrl: file.uri,
        };
    }

    async deleteFile(geminiFileName: string): Promise<void> {
        try {
            await this.ai.files.delete({ name: geminiFileName });
            this.logger.debug({ geminiFileName }, "Deleted Gemini file");
        } catch (err) {
            // Silently ignore not-found errors — file may have already expired
            this.logger.debug(
                { geminiFileName, err },
                "Failed to delete Gemini file (may already be expired)",
            );
        }
    }
}
