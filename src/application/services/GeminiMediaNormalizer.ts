import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import { randomUUIDv7 } from "bun";
import type { GeminiFile } from "../../domain/message/GeminiFile.ts";
import { GeminiFileSourceType } from "../../domain/message/GeminiFile.ts";
import type { GeminiFileUpload } from "../../domain/message/GeminiFileUpload.ts";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import { parseDiscordTokenUrl } from "../../infrastructure/discord/discordTokenUrl.ts";
import type { AppConfig } from "../config/AppConfig.ts";
import type { IDiscordMediaService } from "../ports/IDiscordMediaService.ts";
import type { IGeminiFileRepository } from "../ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploaderRegistry } from "../ports/IGeminiFileUploaderRegistry.ts";
import type { IGeminiMediaNormalizer } from "../ports/IGeminiMediaNormalizer.ts";
import type { IStreamingAttachmentDownloader } from "../ports/IStreamingAttachmentDownloader.ts";
import type { Logger } from "../types/Logger.ts";

/**
 * A content block with a `url` field holding a discord:// token URL.
 */
type TokenBlock = Record<string, unknown> & { type: string; url: string };

/**
 * A content block with a resolved Gemini `fileUri`.
 */
type FileUriBlock = Record<string, unknown> & { type: string; mimeType: string; fileUri: string };

/** Returns true if a block is an unresolved discord:// token URL block. */
function isTokenBlock(block: unknown): block is TokenBlock {
    return (
        typeof block === "object" &&
        block !== null &&
        "url" in block &&
        typeof (block as Record<string, unknown>).url === "string" &&
        ((block as Record<string, unknown>).url as string).startsWith("discord://")
    );
}

/** Returns true if a block is an already-resolved Gemini fileUri block. */
function isFileUriBlock(block: unknown): block is FileUriBlock {
    return (
        typeof block === "object" &&
        block !== null &&
        "fileUri" in block &&
        typeof (block as Record<string, unknown>).fileUri === "string"
    );
}

/**
 * Unified service that resolves and refreshes Gemini media blocks in LangChain message histories.
 *
 * Handles two block shapes:
 * - `{ type:"media", url:"discord://..." }` — token blocks written by `AgentMessageBuilder`.
 *   Resolved to a fresh Gemini `fileUri` via find-or-upload logic keyed by the token URL.
 * - `{ type:"media", fileUri:"https://..." }` — already-resolved blocks from pre-refactor
 *   histories or from a previous agent turn in the same execution. Validated against the DB
 *   for freshness; stale or missing uploads are re-uploaded from Discord.
 *
 * Both block types share the same DB anchor record (`gemini_files.original_gemini_url` as
 * the stable key) and the same staleness/reupload logic, so the normalizer runs once per
 * invocation and covers the full history regardless of how blocks were originally written.
 *
 * Algorithm per token block:
 * - **Not in DB**: download from Discord → upload to Gemini → insert anchor + upload record
 * - **In DB, upload fresh for this key**: use existing `fileUri`
 * - **In DB, upload stale or missing for this key**: re-download → re-upload → upsert record
 * - **Discord media deleted**: drop the block (warn, do not throw)
 *
 * Algorithm per fileUri block (legacy or same-session):
 * - **Not in DB**: cannot re-upload without Discord context — pass through as-is with a warning
 * - **In DB, upload fresh for this key**: pass through unchanged
 * - **In DB, upload stale or missing for this key**: re-download → re-upload → substitute new URI
 * - **Discord media deleted**: drop the block (warn, do not throw)
 *
 * Gemini files are project-scoped — a file uploaded with key A is inaccessible from key B —
 * so `apiKeyId` is provided per `normalize()` call and drives all upload/lookup decisions.
 */
export class GeminiMediaNormalizer implements IGeminiMediaNormalizer {
    /** A file is stale when less than this many ms remain before Gemini deletes it. */
    private readonly staleThresholdMs: number;

    constructor(
        private readonly geminiFileRepo: IGeminiFileRepository,
        private readonly messageRepo: IMessageRepository,
        private readonly uploaderRegistry: IGeminiFileUploaderRegistry,
        private readonly streamingDownloader: IStreamingAttachmentDownloader,
        private readonly mediaService: IDiscordMediaService,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
    ) {
        const geminiTtlMs = 48 * 60 * 60 * 1000;
        this.staleThresholdMs = geminiTtlMs - config.file.geminiFileApi.fileStaleBeforeExpiryMs;
    }

    /**
     * Resolves all `discord://` token URL blocks in `messages` to Gemini `fileUri` blocks.
     * Messages with no token blocks pass through unchanged.
     */
    async normalize(messages: BaseMessage[], apiKeyId: string): Promise<BaseMessage[]> {
        return Sentry.startSpan(
            {
                name: "Normalize Gemini media blocks",
                op: "gemini.files.normalize",
                attributes: { "llm.api_key_id": apiKeyId },
            },
            async (span) => {
                // Collect unique token URLs and existing fileUris across all HumanMessages.
                // Both are keyed by originalGeminiUrl in gemini_files — token URLs for
                // post-refactor blocks, raw Gemini URLs for pre-refactor legacy blocks.
                const tokenUrls = new Set<string>();
                const fileUris = new Set<string>();
                for (const msg of messages) {
                    if (!(msg instanceof HumanMessage) || !Array.isArray(msg.content)) continue;
                    for (const block of msg.content as unknown[]) {
                        if (isTokenBlock(block)) tokenUrls.add(block.url);
                        else if (isFileUriBlock(block)) fileUris.add(block.fileUri);
                    }
                }

                if (tokenUrls.size === 0 && fileUris.size === 0) return messages;

                span.setAttributes({
                    "gemini.token_url_count": tokenUrls.size,
                    "gemini.file_uri_count": fileUris.size,
                });

                // Two focused queries — each handles one block type.
                // Ran concurrently when both sets are non-empty (transition histories);
                // otherwise only one query executes.
                const [byAnchorUrl, byGeminiUrl] = await Promise.all([
                    this.geminiFileRepo.findByOriginalUrl([...tokenUrls], apiKeyId),
                    this.geminiFileRepo.findByUploadUrl([...fileUris], apiKeyId),
                ]);

                const now = Date.now();

                // Resolve each key to a fileUri concurrently — each is an independent upload/fetch.
                // uploadNew/reupload handle all recoverable failures internally and return null;
                // an unexpected throw is a genuine bug and should propagate.
                const entries = [
                    ...[...tokenUrls].map((tokenUrl) => ({ key: tokenUrl, kind: "token" as const })),
                    ...[...fileUris].map((fileUri) => ({ key: fileUri, kind: "fileUri" as const })),
                ];

                const results = await Promise.all(
                    entries.map(async ({ key, kind }) => {
                        const state = kind === "token" ? byAnchorUrl.get(key) : byGeminiUrl.get(key);

                        if (kind === "token") {
                            if (!state) {
                                // No DB anchor yet — new file, upload for the first time
                                return { key, fileUri: await this.uploadNew(key, apiKeyId) };
                            }
                            const { file, upload } = state;
                            if (upload === null) {
                                // Anchor exists but no upload for this key (new key or trigger-cleaned)
                                return { key, fileUri: await this.reupload(key, file, null, apiKeyId) };
                            }
                            if (now - upload.uploadedAt.getTime() >= this.staleThresholdMs) {
                                this.logger.info(
                                    { tokenUrl: key, apiKeyId, uploadedAt: upload.uploadedAt },
                                    "Gemini file upload is stale; re-uploading",
                                );
                                return { key, fileUri: await this.reupload(key, file, upload, apiKeyId) };
                            }
                            // Fresh upload — use existing fileUri
                            return { key, fileUri: upload.geminiUrl };
                        }

                        // kind === "fileUri"
                        if (!state) {
                            // No DB anchor — pre-refactor block, cannot re-upload without Discord context.
                            this.logger.warn(
                                { fileUri: key, apiKeyId },
                                "Gemini fileUri block has no DB anchor — cannot validate freshness, passing through",
                            );
                            return { key, fileUri: undefined }; // undefined → pass through in applyResolutions
                        }
                        const { file, upload } = state;
                        if (upload === null || now - upload.uploadedAt.getTime() >= this.staleThresholdMs) {
                            if (upload !== null) {
                                this.logger.info(
                                    { fileUri: key, apiKeyId, uploadedAt: upload.uploadedAt },
                                    "Existing Gemini fileUri is stale; re-uploading",
                                );
                            }
                            return { key, fileUri: await this.reupload(key, file, upload, apiKeyId) };
                        }
                        // Fresh — no substitution needed
                        return { key, fileUri: undefined };
                    }),
                );

                // Maps original key → resolved fileUri (or null = drop block); undefined = pass through, not added
                const resolvedUrls = new Map<string, string | null>();
                for (const { key, fileUri } of results) {
                    if (fileUri !== undefined) {
                        resolvedUrls.set(key, fileUri);
                    }
                }

                span.setAttribute("gemini.resolved_count", resolvedUrls.size);

                return this.applyResolutions(messages, resolvedUrls);
            },
        );
    }

    /**
     * Handles a token URL with no existing DB anchor: resolves the token, downloads
     * the media from Discord, uploads to Gemini, and persists both the anchor and
     * the upload record.
     *
     * Returns the new Gemini `fileUri`, or `null` if the Discord media is gone.
     */
    private async uploadNew(tokenUrl: string, apiKeyId: string): Promise<string | null> {
        return Sentry.startSpan({ name: "Upload new Gemini file", op: "gemini.files.upload_new" }, async () => {
            const token = parseDiscordTokenUrl(tokenUrl);
            if (!token) {
                this.logger.warn({ tokenUrl }, "Cannot parse discord token URL for new upload — dropping block");
                return null;
            }

            // Fetch fresh CDN URL from Discord
            const attachment =
                token.kind === "attachment"
                    ? await this.mediaService.fetchAttachment(token.channelId, token.messageId, token.attachmentId)
                    : await this.mediaService.fetchEmbedMedia(
                          token.channelId,
                          token.messageId,
                          token.embedIndex,
                          token.mediaKey,
                      );

            if (!attachment) {
                this.logger.warn({ tokenUrl }, "Discord media not found for new upload — dropping block");
                return null;
            }

            const { stream, mimeType, byteLength } = await this.streamingDownloader.downloadStream(attachment);
            const uploader = this.uploaderRegistry.get(apiKeyId);
            const uploaded = await uploader.uploadStream(
                stream,
                `files/${randomUUIDv7()}`,
                mimeType,
                attachment.name,
                byteLength ?? attachment.size,
            );

            // Build the anchor record from the parsed token
            const anchorBase =
                token.kind === "attachment"
                    ? {
                          sourceType: GeminiFileSourceType.ATTACHMENT,
                          discordAttachmentId: token.attachmentId,
                          discordFilename: attachment.name,
                          embedIndex: null,
                          embedMediaKey: null,
                      }
                    : {
                          sourceType: GeminiFileSourceType.EMBED_MEDIA,
                          discordAttachmentId: null,
                          discordFilename: null,
                          embedIndex: token.embedIndex,
                          embedMediaKey: token.mediaKey,
                      };

            // messageId FK: look up the messages row UUID from the discord snowflake encoded in the token
            const messageId = await this.messageRepo.getIdByDiscordMessageId({
                discordMessageId: token.messageId,
                channelId: token.channelId,
                guildId: token.guildId,
            });

            if (!messageId) {
                // Message row not found — can't satisfy FK. Log and skip persisting anchor,
                // but still return the uploaded fileUri so this request succeeds.
                this.logger.warn(
                    { tokenUrl, discordMessageId: token.messageId },
                    "messages row not found for discord token — Gemini file anchor not persisted",
                );
                return uploaded.geminiUrl;
            }

            const [savedFile] = await this.geminiFileRepo.saveFiles([
                { ...anchorBase, originalGeminiUrl: tokenUrl, messageId },
            ]);

            await this.geminiFileRepo.upsertUpload({
                // biome-ignore lint/style/noNonNullAssertion: saveFiles always returns index-aligned results
                geminiFileId: savedFile!.id,
                apiKeyId,
                geminiFileName: uploaded.geminiFileName,
                geminiUrl: uploaded.geminiUrl,
                uploadedAt: new Date(),
            });

            this.logger.info({ tokenUrl, geminiUrl: uploaded.geminiUrl, apiKeyId }, "Uploaded new Gemini file");

            return uploaded.geminiUrl;
        });
    }

    /**
     * Re-downloads and re-uploads a file whose anchor exists but whose upload record is
     * missing (new key / trigger-cleaned) or stale (approaching Gemini TTL).
     *
     * Returns the new Gemini `fileUri`, or `null` if the Discord media is gone.
     */
    private async reupload(
        tokenUrl: string,
        file: GeminiFile,
        existingUpload: GeminiFileUpload | null,
        apiKeyId: string,
    ): Promise<string | null> {
        return Sentry.startSpan(
            {
                name: "Re-upload Gemini file",
                op: "gemini.files.reupload",
                attributes: { "gemini.is_stale_refresh": existingUpload !== null },
            },
            async () => {
                let attachment: Awaited<ReturnType<typeof this.mediaService.fetchAttachment>>;

                if (file.sourceType === GeminiFileSourceType.EMBED_MEDIA) {
                    if (file.embedIndex === null || file.embedMediaKey === null) {
                        this.logger.error(
                            { tokenUrl, fileId: file.id },
                            "embed_media record missing embedIndex or embedMediaKey — skipping re-upload",
                        );
                        return null;
                    }
                    attachment = await this.mediaService.fetchEmbedMedia(
                        file.discordChannelId,
                        file.discordMessageId,
                        file.embedIndex,
                        file.embedMediaKey,
                    );
                } else {
                    if (file.discordAttachmentId === null) {
                        this.logger.error(
                            { tokenUrl, fileId: file.id },
                            "attachment record missing discordAttachmentId — skipping re-upload",
                        );
                        return null;
                    }
                    attachment = await this.mediaService.fetchAttachment(
                        file.discordChannelId,
                        file.discordMessageId,
                        file.discordAttachmentId,
                    );
                }

                if (!attachment) {
                    this.logger.warn(
                        { tokenUrl, sourceType: file.sourceType, discordMessageId: file.discordMessageId },
                        "Discord media no longer exists — dropping block",
                    );
                    return null;
                }

                const { stream, mimeType, byteLength } = await this.streamingDownloader.downloadStream(attachment);
                const uploader = this.uploaderRegistry.get(apiKeyId);
                const uploaded = await uploader.uploadStream(
                    stream,
                    `files/${randomUUIDv7()}`,
                    mimeType,
                    attachment.name,
                    byteLength ?? attachment.size,
                );

                // Delete the old Gemini file best-effort (may already be expired)
                if (existingUpload !== null) {
                    void uploader.deleteFile(existingUpload.geminiFileName);
                }

                await this.geminiFileRepo.upsertUpload({
                    geminiFileId: file.id,
                    apiKeyId,
                    geminiFileName: uploaded.geminiFileName,
                    geminiUrl: uploaded.geminiUrl,
                    uploadedAt: new Date(),
                });

                this.logger.info({ tokenUrl, newGeminiUrl: uploaded.geminiUrl, apiKeyId }, "Re-uploaded Gemini file");

                return uploaded.geminiUrl;
            },
        );
    }

    /**
     * Returns a new message array with token URL blocks replaced by resolved `fileUri` blocks.
     *
     * - `null` resolution: block is dropped (media deleted).
     * - String resolution: token block replaced with `{ type:"media", mimeType, fileUri }`.
     * - Unchanged messages are returned as-is (no new object created).
     */
    private applyResolutions(messages: BaseMessage[], resolved: Map<string, string | null>): BaseMessage[] {
        return messages.map((msg) => {
            if (!(msg instanceof HumanMessage) || !Array.isArray(msg.content)) return msg;

            let modified = false;
            const newBlocks = [];

            for (const block of msg.content) {
                if (isTokenBlock(block)) {
                    const fileUri = resolved.get(block.url);
                    if (fileUri === undefined) {
                        // Not in resolution map — token was not scanned (shouldn't happen), keep as-is
                        newBlocks.push(block);
                    } else if (fileUri === null) {
                        // Media deleted — drop block
                        modified = true;
                    } else {
                        // Replace token with resolved fileUri block
                        const { url: _url, ...rest } = block;
                        newBlocks.push({ ...rest, fileUri } as FileUriBlock);
                        modified = true;
                    }
                } else if (isFileUriBlock(block)) {
                    const newFileUri = resolved.get(block.fileUri);
                    if (newFileUri === null) {
                        // Media deleted after re-upload attempt — drop block
                        modified = true;
                    } else if (newFileUri !== undefined) {
                        // Stale URI was re-uploaded — substitute the new fileUri
                        newBlocks.push({ ...block, fileUri: newFileUri } as FileUriBlock);
                        modified = true;
                    } else {
                        // Fresh or no-anchor block — pass through unchanged
                        newBlocks.push(block);
                    }
                } else {
                    newBlocks.push(block);
                }
            }

            if (!modified) return msg;

            // TYPE COERCION: newBlocks is unknown[] (valid LangChain content blocks at runtime).
            return new HumanMessage({ content: newBlocks });
        });
    }
}
