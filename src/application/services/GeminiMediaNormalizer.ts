import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import { randomUUIDv7 } from "bun";
import { LRUCache } from "lru-cache";
import type { GeminiFile } from "../../domain/entities/GeminiFile.ts";
import type { GeminiFileUpload } from "../../domain/entities/GeminiFileUpload.ts";
import type { IGeminiFileRepository } from "../../domain/ports/IGeminiFileRepository.ts";
import type { IMessageRepository } from "../../domain/ports/IMessageRepository.ts";
import type { AppConfig } from "../config/AppConfig.ts";
import { parseDiscordTokenUrl } from "../helpers/discordTokenUrl.ts";
import { isDiscordTokenUrl, isExternalFileUrl } from "../helpers/mediaTokenUrl.ts";
import type { IGeminiFileUploaderRegistry } from "../ports/IGeminiFileUploaderRegistry.ts";
import type { IGeminiMediaNormalizer } from "../ports/IGeminiMediaNormalizer.ts";
import type { IMediaSource } from "../ports/IMediaSource.ts";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";
import { AgentStatusType } from "../types/AgentStatus.ts";
import type { Logger } from "../types/Logger.ts";

/**
 * A content block whose `url` field holds a media token URL: a `discord://` token, or the
 * `http(s)://` URL of a file the website tool found.
 * `mimeType` is always present on media token blocks: verified via HEAD request at build time
 * for Discord media, and taken from the response headers for external files.
 */
type TokenBlock = Record<string, unknown> & { type: string; url: string; mimeType: string };

/**
 * A content block with a resolved Gemini `fileUri`.
 */
type FileUriBlock = Record<string, unknown> & { type: string; mimeType: string; fileUri: string };

/**
 * Returns true if a block is an unresolved media token URL block.
 *
 * External URLs are only recognized on `media` blocks, so that other block types carrying a
 * web URL are never mistaken for a file to upload.
 *
 * @throws Error when a Discord token block is missing its mimeType
 */
function isTokenBlock(block: unknown): block is TokenBlock {
    const b = block as Record<string, unknown>;
    if (typeof block !== "object" || block === null || typeof b.url !== "string") return false;

    if (isDiscordTokenUrl(b.url)) {
        if (typeof b.mimeType !== "string") {
            throw new Error(`Programmatic Error - Discord token block is missing mimeType: ${b.url}`);
        }
        return true;
    }
    return b.type === "media" && typeof b.mimeType === "string" && isExternalFileUrl(b.url);
}

/**
 * Text left in place of an external file that can no longer be fetched. The tool result next
 * to it still says the file was retrieved, so the model has to be told that it is gone.
 */
function unavailableFileNotice(url: string): string {
    return `[The file at ${url} is no longer available and could not be loaded]`;
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
 * - `{ type:"media", url:"discord://..." }` — token blocks written by `AgentMessageBuilder`,
 *   and `{ type:"media", url:"https://..." }` — blocks for files the website tool found.
 *   Resolved to a fresh Gemini `fileUri` via find-or-upload logic keyed by the token URL.
 * - `{ type:"media", fileUri:"https://..." }` — already-resolved blocks from pre-refactor
 *   histories or from a previous agent turn in the same execution. Validated against the DB
 *   for freshness; stale or missing uploads are re-uploaded from the media's origin.
 *
 * Both block types share the same DB anchor record (`gemini_files.original_gemini_url` as
 * the stable key) and the same staleness/reupload logic, so the normalizer runs once per
 * invocation and covers the full history regardless of how blocks were originally written.
 *
 * Algorithm per token block:
 * - **Not in DB**: download from the origin → upload to Gemini → insert anchor + upload record
 * - **In DB, upload fresh for this key**: use existing `fileUri`
 * - **In DB, upload stale or missing for this key**: re-download → re-upload → upsert record
 * - **Media gone from its origin**: drop the block; an external file leaves a notice in its place
 *
 * Algorithm per fileUri block (legacy or same-session):
 * - **Not in DB**: cannot re-upload without the token URL — pass through as-is with a warning
 * - **In DB, upload fresh for this key**: pass through unchanged
 * - **In DB, upload stale or missing for this key**: re-download → re-upload → substitute new URI
 * - **Media gone from its origin**: drop the block (warn, do not throw)
 *
 * Gemini files are project-scoped — a file uploaded with key A is inaccessible from key B —
 * so `apiKeyId` is provided per `normalize()` call and drives all upload/lookup decisions.
 */
export class GeminiMediaNormalizer implements IGeminiMediaNormalizer {
    /** A file is stale when less than this many ms remain before Gemini deletes it. */
    private readonly staleThresholdMs: number;
    /**
     * Cache TTL: staleThresholdMs minus an additional 15-minute safety buffer, so cached
     * entries are always evicted before the upload could go stale under any circumstances.
     * Per-entry TTL for existing uploads is computed as `staleCacheThresholdMs - age`.
     */
    private readonly staleCacheThresholdMs: number;
    /**
     * In-process LRU cache mapping `${apiKeyId}:${originalUrl}` → resolved Gemini fileUri.
     * Default TTL covers fresh uploads; existing uploads use per-entry TTL based on remaining
     * lifetime. Only successful (non-null) resolutions are cached.
     */
    private readonly fileUriCache: LRUCache<string, string>;

    constructor(
        private readonly geminiFileRepo: IGeminiFileRepository,
        private readonly messageRepo: IMessageRepository,
        private readonly uploaderRegistry: IGeminiFileUploaderRegistry,
        private readonly mediaSource: IMediaSource,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
    ) {
        const geminiTtlMs = 48 * 60 * 60 * 1000; // 48 hours
        this.staleThresholdMs = geminiTtlMs - config.file.geminiFileApi.fileStaleBeforeExpiryMs;
        this.staleCacheThresholdMs = this.staleThresholdMs - 15 * 60 * 1000; // minus 15 minutes
        this.fileUriCache = new LRUCache<string, string>({
            max: config.file.cache.geminiFileUrls,
            ttl: this.staleCacheThresholdMs,
        });
    }

    /**
     * Resolves all media token URL blocks in `messages` to Gemini `fileUri` blocks.
     * Messages with no token blocks pass through unchanged.
     */
    async normalize(
        messages: BaseMessage[],
        apiKeyId: string,
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<BaseMessage[]> {
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
                // tokenUrls maps url → mimeType (HEAD-verified at build time, used as acceptTypes on download).
                const tokenUrls = new Map<string, string>();
                const fileUris = new Set<string>();
                for (const msg of messages) {
                    if (!Array.isArray(msg.content)) continue;
                    for (const block of msg.content as unknown[]) {
                        if (isTokenBlock(block)) tokenUrls.set(block.url, block.mimeType);
                        else if (isFileUriBlock(block)) fileUris.add(block.fileUri);
                    }
                }

                if (tokenUrls.size === 0 && fileUris.size === 0) return messages;

                // Short-circuit cache hits — populate resolvedUrls directly without a DB query.
                // Only keys with no cache entry proceed to the DB + upload path.
                const resolvedUrls = new Map<string, string | null>();
                const uncachedTokenUrls = new Map<string, string>();
                const uncachedFileUris = new Set<string>();

                for (const [key, mimeType] of tokenUrls) {
                    const cached = this.fileUriCache.get(`${apiKeyId}:${key}`);
                    if (cached !== undefined) resolvedUrls.set(key, cached);
                    else uncachedTokenUrls.set(key, mimeType);
                }
                for (const key of fileUris) {
                    const cached = this.fileUriCache.get(`${apiKeyId}:${key}`);
                    if (cached !== undefined) resolvedUrls.set(key, cached);
                    else uncachedFileUris.add(key);
                }

                span.setAttributes({
                    "gemini.token_url_count": tokenUrls.size,
                    "gemini.file_uri_count": fileUris.size,
                    "gemini.cache_hits": resolvedUrls.size,
                });

                if (uncachedTokenUrls.size === 0 && uncachedFileUris.size === 0) {
                    return this.applyResolutions(messages, resolvedUrls);
                }

                // Two focused queries — each handles one block type.
                // Only executed when the corresponding set is non-empty; skipped entirely on a
                // full cache hit. Ran concurrently when both sets are non-empty (transition histories).
                const emptyMap = new Map<string, { file: GeminiFile; upload: GeminiFileUpload | null }>();
                const [byAnchorUrl, byGeminiUrl] = await Promise.all([
                    uncachedTokenUrls.size > 0
                        ? this.geminiFileRepo.findByOriginalUrl([...uncachedTokenUrls.keys()], apiKeyId)
                        : emptyMap,
                    uncachedFileUris.size > 0
                        ? this.geminiFileRepo.findByUploadUrl([...uncachedFileUris], apiKeyId)
                        : emptyMap,
                ]);

                const now = Date.now();

                // Resolve each key to a fileUri concurrently — each is an independent upload/fetch.
                // uploadNew/reupload handle all recoverable failures internally and return null;
                // an unexpected throw is a genuine bug and should propagate.
                const entries = [
                    ...[...uncachedTokenUrls.entries()].map(([tokenUrl, mimeType]) => ({
                        key: tokenUrl,
                        mimeType,
                        kind: "token" as const,
                    })),
                    ...[...uncachedFileUris].map((fileUri) => ({ key: fileUri, kind: "fileUri" as const })),
                ];

                // Fired at most once — only when the first actual download/upload is about to begin.
                let statusFired = false;
                const fireStatus = () => {
                    if (!statusFired) {
                        onStatusUpdate?.({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS });
                        statusFired = true;
                    }
                };

                const results = await Promise.all(
                    entries.map(async (entry) => {
                        const { key, kind } = entry;
                        const state = kind === "token" ? byAnchorUrl.get(key) : byGeminiUrl.get(key);

                        if (kind === "token") {
                            const { mimeType } = entry;
                            if (!state) {
                                // No DB anchor yet — new file, upload for the first time
                                fireStatus();
                                return { key, fileUri: await this.uploadNew(key, mimeType, apiKeyId) };
                            }
                            const { file, upload } = state;
                            if (upload === null) {
                                // Anchor exists but no upload for this key (new key or trigger-cleaned)
                                fireStatus();
                                return { key, fileUri: await this.reupload(key, mimeType, file, null, apiKeyId) };
                            }
                            if (now - upload.uploadedAt.getTime() >= this.staleThresholdMs) {
                                this.logger.info(
                                    { tokenUrl: key, apiKeyId, uploadedAt: upload.uploadedAt },
                                    "Gemini file upload is stale; re-uploading",
                                );
                                fireStatus();
                                return { key, fileUri: await this.reupload(key, mimeType, file, upload, apiKeyId) };
                            }
                            // Fresh upload — use existing fileUri, with remaining TTL so the
                            // cache entry expires at the same time the upload would go stale.
                            const cacheTtl = this.staleCacheThresholdMs - (now - upload.uploadedAt.getTime());
                            return { key, fileUri: upload.geminiUrl, cacheTtl };
                        }

                        // kind === "fileUri"
                        if (!state) {
                            // No DB anchor — pre-refactor block, cannot re-upload without the token URL.
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
                            fireStatus();
                            return { key, fileUri: await this.reupload(key, undefined, file, upload, apiKeyId) };
                        }
                        // Fresh — no substitution needed, but cache with remaining TTL so future
                        // invocations skip the DB lookup entirely.
                        const cacheTtl = this.staleCacheThresholdMs - (now - upload.uploadedAt.getTime());
                        return { key, fileUri: undefined, cacheTtl };
                    }),
                );

                // Merge results into resolvedUrls (cache hits already populated above).
                // undefined = pass through unchanged (no anchor); null = drop block (media deleted).
                // Populate cache for successful resolutions only — null is never cached.
                // Per-entry TTL is set when we know the remaining lifetime of an existing upload;
                // otherwise the cache default (staleThresholdMs) applies for fresh uploads.
                for (const { key, fileUri, cacheTtl } of results) {
                    const ttlOption = cacheTtl !== undefined ? { ttl: cacheTtl } : undefined;
                    if (fileUri !== undefined) {
                        resolvedUrls.set(key, fileUri);
                        if (fileUri !== null) {
                            this.fileUriCache.set(`${apiKeyId}:${key}`, fileUri, ttlOption);
                        }
                    } else if (cacheTtl !== undefined) {
                        // Pass-through (fileUri kind, already fresh) — cache the key as its own value
                        // so future normalize calls skip the DB lookup for this entry.
                        this.fileUriCache.set(`${apiKeyId}:${key}`, key, ttlOption);
                    }
                }

                span.setAttribute("gemini.resolved_count", resolvedUrls.size);

                return this.applyResolutions(messages, resolvedUrls);
            },
        );
    }

    /**
     * Handles a token URL with no existing DB anchor: opens the media at its origin, uploads it
     * to Gemini, and persists both the anchor and the upload record.
     *
     * Returns the new Gemini `fileUri`, or `null` if the media is gone.
     */
    private async uploadNew(
        tokenUrl: string,
        expectedMimeType: string | undefined,
        apiKeyId: string,
    ): Promise<string | null> {
        return Sentry.startSpan({ name: "Upload new Gemini file", op: "gemini.files.upload_new" }, async () => {
            const media = await this.mediaSource.open(tokenUrl, expectedMimeType);
            if (!media) {
                this.logger.warn({ tokenUrl }, "Media not available for new upload — dropping block");
                return null;
            }

            const uploader = this.uploaderRegistry.get(apiKeyId);
            const uploaded = await uploader.uploadStream(
                media.stream,
                `files/${randomUUIDv7()}`,
                media.mimeType,
                media.name,
                media.byteLength,
            );

            const anchor = await this.resolveAnchorMessage(tokenUrl);
            if (anchor === undefined) {
                // Message row not found — can't satisfy FK. Log and skip persisting anchor,
                // but still return the uploaded fileUri so this request succeeds.
                this.logger.warn(
                    { tokenUrl },
                    "messages row not found for discord token — Gemini file anchor not persisted",
                );
                return uploaded.geminiUrl;
            }

            // The token URL is the whole anchor: it is all that is needed to find the media again
            const [savedFile] = await this.geminiFileRepo.saveFiles([
                { originalGeminiUrl: tokenUrl, messageId: anchor },
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
     * Determines the `messages` row a new anchor belongs to.
     *
     * A Discord token is owned by the message it was posted in. An external file is owned by no
     * message: its anchor is keyed by the URL alone and shared by every conversation fetching it.
     *
     * @returns The row's UUID, `null` for an external file, or `undefined` when the message a
     *   Discord token points at has no row
     */
    private async resolveAnchorMessage(tokenUrl: string): Promise<string | null | undefined> {
        if (!isDiscordTokenUrl(tokenUrl)) return null;

        const token = parseDiscordTokenUrl(tokenUrl);
        if (!token) return undefined;

        const messageId = await this.messageRepo.getIdByDiscordMessageId({
            discordMessageId: token.messageId,
            channelId: token.channelId,
            guildId: token.guildId,
        });
        return messageId ?? undefined;
    }

    /**
     * Re-downloads and re-uploads a file whose anchor exists but whose upload record is
     * missing (new key / trigger-cleaned) or stale (approaching Gemini TTL).
     *
     * The media is located through the anchor's own token URL rather than `blockKey`, which is
     * a Gemini fileUri when the block was already resolved earlier.
     *
     * @param blockKey - The URL found in the content block: a token URL or a Gemini fileUri. Used for logging only.
     *
     * Returns the new Gemini `fileUri`, or `null` if the media is gone.
     */
    private async reupload(
        blockKey: string,
        expectedMimeType: string | undefined,
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
                const tokenUrl = file.originalGeminiUrl;

                // Anchors created before token URLs existed hold the first Gemini upload URI
                // and belong to a message. Only an anchor without a message is an external
                // file, so such a legacy web URL must not be fetched as one.
                if (isExternalFileUrl(tokenUrl) && file.messageId !== null) {
                    this.logger.error(
                        { blockKey, tokenUrl, fileId: file.id },
                        "Gemini file anchor does not hold a media token URL — skipping re-upload",
                    );
                    return null;
                }

                const media = await this.mediaSource.open(tokenUrl, expectedMimeType);

                if (!media) {
                    this.logger.warn(
                        { blockKey, tokenUrl, fileId: file.id },
                        "Media no longer available for re-upload — dropping block",
                    );
                    return null;
                }

                const uploader = this.uploaderRegistry.get(apiKeyId);
                const uploaded = await uploader.uploadStream(
                    media.stream,
                    `files/${randomUUIDv7()}`,
                    media.mimeType,
                    media.name,
                    media.byteLength,
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
     * - `null` resolution: block is dropped (media deleted). An external file leaves a notice
     *   in its place, as the tool result beside it still claims the file was retrieved.
     * - String resolution: token block replaced with `{ type:"media", mimeType, fileUri }`.
     * - Unchanged messages are returned as-is (no new object created).
     */
    private applyResolutions(messages: BaseMessage[], resolved: Map<string, string | null>): BaseMessage[] {
        return messages.map((msg) => {
            if (!Array.isArray(msg.content)) return msg;

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
                        if (isExternalFileUrl(block.url)) {
                            newBlocks.push({ type: "text", text: unavailableFileNotice(block.url) });
                        }
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
