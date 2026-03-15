import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { GeminiFile } from "../domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../domain/message/GeminiFileUpload.ts";
import type { AppConfig } from "./config/AppConfig.ts";
import type { IDiscordAttachmentRefetcher } from "./ports/IDiscordAttachmentRefetcher.ts";
import type { IDiskAttachmentDownloader } from "./ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "./ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploaderRegistry } from "./ports/IGeminiFileUploaderRegistry.ts";
import type { Logger } from "./types/Logger.ts";

/** URL prefix that identifies a Gemini Files API URI in a content block. */
const GEMINI_URL_PREFIX = "https://generativelanguage.googleapis.com";

/** Temp directory base path for streamed attachment files. */
// NOTE: must be absolute or use path resolve
const TEMP_DIR = "/var/tmp/genie-attachments";

/**
 * A content block with a `fileUri` field (upload-mode attachment reference).
 * Uses legacy LangChain media format: { type: "media", mimeType, fileUri }.
 * The `fileUri` field lives in `message.content` — the @langchain/google converter
 * reads it there and converts to `{ fileData: { fileUri, mimeType } }` for the REST payload.
 */
type FileUriContentBlock = Record<string, unknown> & {
    type: string;
    fileUri: string;
};

/** Returns true if a content block is a Gemini file reference (has a Gemini fileUri). */
function isGeminiBlock(block: unknown): block is FileUriContentBlock {
    return (
        typeof block === "object" &&
        block !== null &&
        "fileUri" in block &&
        typeof block.fileUri === "string" &&
        block.fileUri.startsWith(GEMINI_URL_PREFIX)
    );
}

/**
 * Extracts all Gemini file URIs from a structured-content HumanMessage.
 * Returns an empty array for string-content messages and non-HumanMessages.
 */
function extractGeminiUrls(message: BaseMessage): string[] {
    if (!(message instanceof HumanMessage)) return [];
    if (!Array.isArray(message.content)) return [];
    // TYPE COERCION: after Array.isArray, message.content is MessageContentComplex[];
    // widened to unknown[] so the isGeminiBlock type predicate (which takes unknown) can
    // be used in filter — TypeScript requires S extends T in Array<T>.filter<S>, and
    // FileUriContentBlock does not extend MessageContentComplex in its type system.
    return (message.content as unknown[]).filter(isGeminiBlock).map((block) => block.fileUri);
}

/**
 * Pre-invocation service that ensures all Gemini file references in the
 * conversation history are fresh for the **current API key** before the LLM is called.
 *
 * Gemini files are project-scoped — a file uploaded with key A is inaccessible
 * from key B. This service therefore checks and refreshes files per (URL, apiKeyId)
 * pair, not globally.
 *
 * Uses a two-table design:
 * - `gemini_files` — permanent anchor with Discord metadata (never deleted)
 * - `gemini_file_uploads` — ephemeral per-key upload tracking (trigger-cleaned after 48h)
 *
 * The LEFT JOIN query (`findWithUploadStateForKey`) always returns a `file` record
 * with Discord context, even when the `upload` record is null (first use of this key,
 * or trigger-cleaned stale row). This allows re-upload without scanning message JSON.
 *
 * Behavior:
 * - `upload === null` → file never uploaded for this key (or was trigger-cleaned); upload now.
 * - `upload !== null` and stale → re-download from Discord and re-upload to Gemini.
 * - `upload !== null` and fresh but `geminiUrl !== originalUrl` → substitute URL in history
 *   (prior refresh updated DB but history still holds the original URL).
 * - Discord attachment gone → remove content block silently and continue.
 * - Gemini re-upload failure → throw (fail the whole request).
 */
export class GeminiFileRefreshService {
    /** Gemini file TTL is 48 hours. Files older than (TTL - staleThresholdMs) are refreshed. */
    private readonly staleThresholdMs: number;

    constructor(
        private readonly geminiFileRepo: IGeminiFileRepository,
        private readonly uploaderRegistry: IGeminiFileUploaderRegistry,
        private readonly diskDownloader: IDiskAttachmentDownloader,
        private readonly logger: Logger,
        config: Pick<AppConfig, "geminiFileStaleThresholdMinutes">,
    ) {
        // Gemini TTL is 48 hours; a file is stale when less than staleThreshold remains
        const geminiTtlMs = 48 * 60 * 60 * 1000;
        this.staleThresholdMs = geminiTtlMs - config.geminiFileStaleThresholdMinutes * 60 * 1000;
    }

    /**
     * Scans `messages` for Gemini file URL references, ensures each is uploaded and
     * fresh for the given `apiKeyId`, and returns a new message array with current URLs.
     *
     * Messages with no Gemini URLs pass through unchanged.
     * Content blocks whose Discord attachment is no longer available are removed.
     *
     * @param messages - Conversation history (may contain Gemini URL blocks)
     * @param refetcher - Per-request Discord attachment fetcher for the current channel
     * @param apiKeyId - The DB UUID of the API key currently being used for LLM invocation
     * @returns New message array with fresh Gemini URLs substituted
     */
    async refreshHistory(
        messages: BaseMessage[],
        refetcher: IDiscordAttachmentRefetcher,
        apiKeyId: string,
    ): Promise<BaseMessage[]> {
        return Sentry.startSpan(
            {
                name: "Refresh Gemini file history",
                op: "gemini.files.refresh_history",
                attributes: {
                    "gemini.file_url_count": messages.flatMap(extractGeminiUrls).length,
                    "llm.api_key_id": apiKeyId,
                },
            },
            async (span) => {
                // Collect all Gemini URLs present in the history
                const allGeminiUrls = messages.flatMap(extractGeminiUrls);
                if (allGeminiUrls.length === 0) return messages;

                // LEFT JOIN: always returns GeminiFile (discord context); upload is null if
                // the file has never been uploaded for this key or was trigger-cleaned.
                const fileStateMap = await this.geminiFileRepo.findWithUploadStateForKey(allGeminiUrls, apiKeyId);

                // Build URL substitution map: originalUrl → new geminiUrl (or null if attachment deleted)
                const urlSubstitutions = new Map<string, string | null>();
                const now = Date.now();

                for (const [originalUrl, { file, upload }] of fileStateMap) {
                    if (upload === null) {
                        // Never uploaded for this key (new key or trigger-cleaned row)
                        const newUrl = await this.refreshOne(originalUrl, file, null, apiKeyId, refetcher);
                        urlSubstitutions.set(originalUrl, newUrl);
                    } else if (now - upload.uploadedAt.getTime() >= this.staleThresholdMs) {
                        // Upload exists but is approaching or past expiry
                        this.logger.info(
                            {
                                originalUrl,
                                apiKeyId,
                                uploadedAt: upload.uploadedAt,
                            },
                            "Gemini file upload is stale; refreshing",
                        );
                        const newUrl = await this.refreshOne(originalUrl, file, upload, apiKeyId, refetcher);
                        urlSubstitutions.set(originalUrl, newUrl);
                    } else if (upload.geminiUrl !== originalUrl) {
                        // Fresh upload exists but with a different URL (prior refresh updated the URL in DB
                        // but the LangChain history still holds the originalGeminiUrl). Substitute silently.
                        urlSubstitutions.set(originalUrl, upload.geminiUrl);
                    }
                    // else: fresh upload with unchanged URL — no substitution needed
                }

                span.setAttribute("gemini.substitutions_count", urlSubstitutions.size);

                if (urlSubstitutions.size === 0) return messages;

                return this.applySubstitutions(messages, urlSubstitutions);
            },
        );
    }

    /**
     * Re-downloads and re-uploads a single Gemini file for the given API key.
     *
     * Handles both the "missing" case (no prior upload for this key) and the
     * "stale" case (upload exists but is expiring). When stale, the old Gemini
     * file is deleted best-effort after the new one is confirmed uploaded.
     *
     * @param originalUrl - The stable originalGeminiUrl stored in content blocks (lookup key)
     * @param file - Permanent GeminiFile anchor with Discord metadata for re-downloading
     * @param existingUpload - Existing upload record (for stale case) or null (for missing case)
     * @param apiKeyId - The API key to use for this upload
     * @param refetcher - Per-request Discord attachment fetcher
     * @returns The new Gemini URL, or `null` if the Discord attachment was deleted
     * @throws If the Gemini upload fails (propagated to fail the whole request)
     */
    private async refreshOne(
        originalUrl: string,
        file: GeminiFile,
        existingUpload: GeminiFileUpload | null,
        apiKeyId: string,
        refetcher: IDiscordAttachmentRefetcher,
    ): Promise<string | null> {
        return Sentry.startSpan(
            {
                name: "Refresh single Gemini file",
                op: "gemini.files.refresh_one",
                attributes: {
                    "llm.api_key_id": apiKeyId,
                    "gemini.is_stale_refresh": existingUpload !== null,
                },
            },
            async () => {
                // Re-fetch the Discord attachment to get a fresh CDN URL
                const attachment = await refetcher.fetchAttachment(file.discordMessageId, file.discordAttachmentId);

                if (!attachment) {
                    this.logger.warn(
                        {
                            discordAttachmentId: file.discordAttachmentId,
                            discordMessageId: file.discordMessageId,
                        },
                        "Discord attachment no longer exists; removing block from history",
                    );
                    return null;
                }

                const tempPath = join(TEMP_DIR, `${Bun.randomUUIDv7()}-${file.discordFilename}`);
                try {
                    // Stream attachment to disk
                    const mimeType = await this.diskDownloader.downloadToFile(attachment, tempPath);

                    // Upload to Gemini using the uploader for this specific API key
                    const uploader = this.uploaderRegistry.get(apiKeyId);
                    const newFileName = `files/${Bun.randomUUIDv7()}`;
                    const uploaded = await uploader.upload(tempPath, newFileName, mimeType, file.discordFilename);

                    // Delete the old Gemini file best-effort (may already be expired).
                    // Not awaited so it doesn't delay the response.
                    if (existingUpload !== null) {
                        void uploader.deleteFile(existingUpload.geminiFileName);
                    }

                    // Persist the new upload record (upserts on conflict for (geminiFileId, apiKeyId))
                    await this.geminiFileRepo.upsertUpload({
                        geminiFileId: file.id,
                        apiKeyId,
                        geminiFileName: uploaded.geminiFileName,
                        geminiUrl: uploaded.geminiUrl,
                        uploadedAt: new Date(),
                    });

                    this.logger.info(
                        {
                            originalUrl,
                            newGeminiUrl: uploaded.geminiUrl,
                            apiKeyId,
                            discordAttachmentId: file.discordAttachmentId,
                        },
                        "Refreshed Gemini file upload",
                    );

                    return uploaded.geminiUrl;
                } finally {
                    // Always clean up the temp file
                    await unlink(tempPath).catch((err) => {
                        this.logger.warn({ tempPath, err }, "Failed to delete temp file after Gemini upload");
                    });
                }
            },
        );
    }

    /**
     * Returns a new message array with Gemini URLs substituted according to the map.
     *
     * - `null` substitution: removes the content block entirely.
     * - String substitution: replaces the `fileUri` field with the new URL.
     * - Unchanged messages are returned as-is (no new object created).
     */
    private applySubstitutions(messages: BaseMessage[], substitutions: Map<string, string | null>): BaseMessage[] {
        return messages.map((msg) => {
            if (!(msg instanceof HumanMessage)) return msg;
            if (!Array.isArray(msg.content)) return msg;

            let modified = false;
            const newBlocks: unknown[] = [];

            // TYPE COERCION: after Array.isArray, msg.content is MessageContentComplex[];
            // widened to unknown[] so isGeminiBlock (which takes unknown) can be used as a
            // narrowing predicate without violating TypeScript's S extends T constraint on filter.
            for (const block of msg.content as unknown[]) {
                if (!isGeminiBlock(block)) {
                    newBlocks.push(block);
                    continue;
                }

                const sub = substitutions.get(block.fileUri);
                if (sub === undefined) {
                    // URI is not in the substitution map — not stale, keep as-is
                    newBlocks.push(block);
                } else if (sub === null) {
                    // Attachment deleted — drop the block
                    modified = true;
                } else {
                    // Substitute with fresh fileUri
                    newBlocks.push({ ...block, fileUri: sub });
                    modified = true;
                }
            }

            if (!modified) return msg;

            // TYPE COERCION: newBlocks is unknown[] (FileUriContentBlock elements at runtime) which
            // TypeScript cannot verify against LangChain's strict MessageContent union type.
            // The blocks are valid legacy media/text content and accepted by the @langchain/google
            // converter at runtime. Double cast through unknown makes the intent explicit.
            return new HumanMessage({
                content: newBlocks as unknown as MessageContent,
            });
        });
    }
}
