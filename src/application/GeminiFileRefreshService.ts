import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { AppConfig } from "./config/AppConfig.ts";
import type { IDiscordAttachmentRefetcher } from "./ports/IDiscordAttachmentRefetcher.ts";
import type { IDiskAttachmentDownloader } from "./ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "./ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploader } from "./ports/IGeminiFileUploader.ts";
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
    return (message.content as unknown[])
        .filter(isGeminiBlock)
        .map((block) => block.fileUri);
}

/**
 * Pre-invocation service that ensures all Gemini file references in the
 * conversation history are fresh before the LLM is called.
 *
 * Gemini files expire 48 hours after upload. This service scans HumanMessage
 * content blocks for Gemini URLs, checks their staleness against the configured
 * threshold, refreshes any stale files by re-downloading from Discord and
 * re-uploading to Gemini, and returns a new BaseMessage array with updated URLs.
 *
 * The original `langchain_messages` DB column is never mutated — only the
 * `gemini_file_uploads` table is updated on refresh.
 *
 * Behavior on attachment loss:
 * - If the Discord attachment no longer exists: silently remove the content
 *   block from history and continue.
 * - If a Gemini re-upload fails: throw an error (fail the whole request).
 */
export class GeminiFileRefreshService {
    /** Gemini file TTL is 48 hours. Files older than (TTL - staleThresholdMs) are refreshed. */
    private readonly staleThresholdMs: number;

    constructor(
        private readonly geminiFileRepo: IGeminiFileRepository,
        private readonly geminiFileUploader: IGeminiFileUploader,
        private readonly diskDownloader: IDiskAttachmentDownloader,
        private readonly logger: Logger,
        config: Pick<AppConfig, "geminiFileStaleThresholdMinutes">,
    ) {
        // Gemini TTL is 48 hours; a file is stale when less than staleThreshold remains
        const geminiTtlMs = 48 * 60 * 60 * 1000;
        this.staleThresholdMs =
            geminiTtlMs - config.geminiFileStaleThresholdMinutes * 60 * 1000;
    }

    /**
     * Scans `messages` for Gemini file URL references, refreshes any that are
     * stale or expiring soon, and returns a new message array with current URLs.
     *
     * Messages with no Gemini URLs pass through unchanged.
     * Content blocks whose Discord attachment is no longer available are removed.
     *
     * @param messages - Conversation history (may contain Gemini URL blocks)
     * @param refetcher - Per-request Discord attachment fetcher for the current channel
     * @returns New message array with fresh Gemini URLs substituted
     */
    async refreshHistory(
        messages: BaseMessage[],
        refetcher: IDiscordAttachmentRefetcher,
    ): Promise<BaseMessage[]> {
        // Collect all Gemini URLs present in the history
        const allGeminiUrls = messages.flatMap(extractGeminiUrls);
        if (allGeminiUrls.length === 0) return messages;

        // Batch-lookup DB records
        const records =
            await this.geminiFileRepo.findByOriginalUrls(allGeminiUrls);

        // Determine which need refreshing (stale threshold exceeded)
        const now = Date.now();
        const staleUrls = new Set<string>();
        for (const [url, record] of records) {
            if (now - record.uploadedAt.getTime() >= this.staleThresholdMs) {
                staleUrls.add(url);
            }
        }

        if (staleUrls.size === 0) return messages;

        this.logger.info(
            { staleCount: staleUrls.size },
            "Refreshing stale Gemini file uploads",
        );

        // Build a URL substitution map: original URL → current URL after refresh
        // For deleted attachments, the URL maps to null (block should be removed)
        const urlSubstitutions = new Map<string, string | null>();

        for (const originalUrl of staleUrls) {
            const record = records.get(originalUrl);
            if (!record) continue;

            const substitution = await this.refreshOne(
                originalUrl,
                record.geminiFileName,
                record.discordAttachmentId,
                record.discordFilename,
                record.messageDiscordId,
                refetcher,
            );
            urlSubstitutions.set(originalUrl, substitution);
        }

        // Apply substitutions to produce updated messages
        return this.applySubstitutions(messages, urlSubstitutions);
    }

    /**
     * Re-downloads and re-uploads a single stale Gemini file.
     *
     * @returns The new Gemini URL, or `null` if the Discord attachment was deleted
     * @throws If the Gemini re-upload fails (propagated to fail the whole request)
     */
    private async refreshOne(
        originalUrl: string,
        oldGeminiFileName: string,
        discordAttachmentId: string,
        discordFilename: string,
        messageDiscordId: string,
        refetcher: IDiscordAttachmentRefetcher,
    ): Promise<string | null> {
        // Re-fetch the Discord attachment to get a fresh CDN URL
        const attachment = await refetcher.fetchAttachment(
            messageDiscordId,
            discordAttachmentId,
        );

        if (!attachment) {
            this.logger.warn(
                { discordAttachmentId, messageDiscordId },
                "Discord attachment no longer exists; removing block from history",
            );
            return null;
        }

        const tempPath = join(TEMP_DIR, `${randomUUID()}-${discordFilename}`);
        try {
            // Stream attachment to disk
            const mimeType = await this.diskDownloader.downloadToFile(
                attachment,
                tempPath,
            );

            // Upload to Gemini with a fresh UUID file name
            const newFileName = `files/${randomUUID()}`;
            const uploaded = await this.geminiFileUploader.upload(
                tempPath,
                newFileName,
                mimeType,
                discordFilename,
            );

            // Delete the old Gemini file (best-effort; may already be expired), not awaiting the promise to avoid delaying the response
            void this.geminiFileUploader.deleteFile(oldGeminiFileName);

            // Persist the updated file record
            await this.geminiFileRepo.updateAfterRefresh(originalUrl, {
                geminiFileName: uploaded.geminiFileName,
                geminiUrl: uploaded.geminiUrl,
                uploadedAt: new Date(),
            });

            this.logger.info(
                {
                    originalUrl,
                    newGeminiUrl: uploaded.geminiUrl,
                    discordAttachmentId,
                },
                "Refreshed Gemini file upload",
            );

            return uploaded.geminiUrl;
        } finally {
            // Always clean up the temp file
            await unlink(tempPath).catch((err) => {
                this.logger.warn(
                    { tempPath, err },
                    "Failed to delete temp file after Gemini upload",
                );
            });
        }
    }

    /**
     * Returns a new message array with Gemini URLs substituted according to the map.
     *
     * - `null` substitution: removes the content block entirely.
     * - String substitution: replaces the `url` field with the new URL.
     * - Unchanged messages are returned as-is (no new object created).
     */
    private applySubstitutions(
        messages: BaseMessage[],
        substitutions: Map<string, string | null>,
    ): BaseMessage[] {
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
