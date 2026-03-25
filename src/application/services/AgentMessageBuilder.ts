import { AIMessage, HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import { randomUUIDv7 } from "bun";
import { EMBED_MEDIA_KEYS, type GeminiFile, GeminiFileSourceType } from "../../domain/message/GeminiFile.ts";
import { buildAttachmentTokenUrl, buildEmbedTokenUrl } from "../../infrastructure/discord/discordTokenUrl.ts";
import { type AppConfig, AttachmentMode } from "../config/AppConfig.ts";
import type { IChatClientMessageAttachment, IChatClientMessageEmbed } from "../ports/chat/IChatClient.ts";
import type { IGeminiFileRepository } from "../ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploaderRegistry } from "../ports/IGeminiFileUploaderRegistry.ts";
import type { IRoundRobinKeyProvider } from "../ports/IRoundRobinKeyProvider.ts";
import type { IStreamingAttachmentDownloader } from "../ports/IStreamingAttachmentDownloader.ts";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";
import { AgentStatusType } from "../types/AgentStatus.ts";
import type { Logger } from "../types/Logger.ts";

/** Returns true if at least one embed contains a URL for any of the tracked media keys. */
function embedsHaveMedia(embeds: IChatClientMessageEmbed[]): boolean {
    return embeds.some((embed) => EMBED_MEDIA_KEYS.some((key) => embed[key]?.url != null));
}

/**
 * Pending data for a single Gemini file upload that must be persisted after
 * the user message row exists (satisfies the `gemini_files.message_discord_id` FK constraint).
 */
export type PendingGeminiRecord = {
    fileAnchor: Omit<GeminiFile, "id" | "messageId" | "discordMessageId" | "discordChannelId">;
    uploadData: {
        geminiFileName: string;
        geminiUrl: string;
        uploadedAt: Date;
    };
};

/**
 * Application service: constructs LangChain messages from chat content and file attachments.
 *
 * Handles two attachment modes:
 * - **Inline**: downloads files to memory as base64 and embeds them directly in the message content parts.
 * - **Upload**: streams files to a temp path, uploads to Gemini Files API, and returns pending
 *   DB records that must be persisted after the message row is saved (FK constraint).
 */
export class AgentMessageBuilder {
    private readonly maxInlineBytes: number;
    private readonly attachmentMode: AttachmentMode;

    /**
     * @param logger - Logger instance
     * @param config - Application config subset for file/attachment settings
     * @param diskDownloader - Required in upload mode; streams files to a temp path
     * @param uploaderRegistry - Required in upload mode; provides uploaders keyed by API key ID
     * @param freeKeyProvider - Required in upload mode; supplies the currently active API key
     * @param geminiFileRepo - Required in upload mode; persists Gemini file metadata
     */
    constructor(
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
        /** Required in upload mode; unused in inline mode. */
        private readonly streamingDownloader?: IStreamingAttachmentDownloader,
        private readonly uploaderRegistry?: IGeminiFileUploaderRegistry,
        private readonly freeKeyProvider?: IRoundRobinKeyProvider,
        private readonly geminiFileRepo?: IGeminiFileRepository,
    ) {
        this.maxInlineBytes = config.file.agent.maxInlineAttachmentSizeBytes;
        this.attachmentMode = config.file.agent.uploadAttachmentMode;
    }

    /**
     * Constructs a LangChain message from content and optional file attachments.
     * Produces a {@link HumanMessage} for role "human" and an {@link AIMessage} for role "assistant".
     *
     * In inline mode, `guildId`, `channelId`, and `discordMessageId` are required — they are
     * encoded into the Discord token URLs stored in media blocks instead of raw base64 data.
     */
    async buildMessage<R extends "human" | "assistant">(params: {
        role: R;
        content: string;
        attachments: IChatClientMessageAttachment[];
        embeds?: IChatClientMessageEmbed[];
        onStatusUpdate?: OnStatusUpdate;
        /** Required in inline mode: encoded into discord:// token URLs for deferred media resolution. */
        guildId?: string;
        /** Required in inline mode: encoded into discord:// token URLs for deferred media resolution. */
        channelId?: string;
        /** Required in inline mode: encoded into discord:// token URLs for deferred media resolution. */
        discordMessageId?: string;
    }): Promise<{
        msg: R extends "human" ? HumanMessage : AIMessage;
        pendingRecords: PendingGeminiRecord[];
    }> {
        const { role, content, attachments, embeds, onStatusUpdate, guildId, channelId, discordMessageId } = params;

        // TYPE COERCION: TypeScript cannot narrow a conditional return type (R extends "human" ? ...)
        // from within the generic implementation body — the union HumanMessage | AIMessage is not
        // assignable to the unresolved conditional type even though it is always correct at runtime.
        const wrap = (contentParts: HumanMessage["content"]) =>
            (role === "human"
                ? new HumanMessage({ content: contentParts })
                : new AIMessage({ content: contentParts })) as R extends "human" ? HumanMessage : AIMessage;

        const hasMedia = attachments.length > 0 || (embeds != null && embedsHaveMedia(embeds));
        if (!hasMedia) {
            return { msg: wrap(content), pendingRecords: [] };
        }

        onStatusUpdate?.({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS });

        if (this.attachmentMode === AttachmentMode.upload) {
            const { contentParts, pendingRecords } = await this.buildUploadModeContentParts(
                content,
                attachments,
                embeds,
            );
            return { msg: wrap(contentParts), pendingRecords };
        }

        const contentParts = await this.buildInlineModeContentParts(
            content,
            attachments,
            embeds,
            guildId,
            channelId,
            discordMessageId,
        );
        return { msg: wrap(contentParts), pendingRecords: [] };
    }

    /**
     * Returns the configured attachment size limit in bytes.
     * Used by callers to validate total attachment size before building a message.
     */
    get maxInlineAttachmentBytes(): number {
        return this.maxInlineBytes;
    }

    /** Returns the configured attachment mode. */
    get mode(): AttachmentMode {
        return this.attachmentMode;
    }

    /**
     * Runs the two-phase Gemini file save for each pending record collected during
     * {@link buildMessage} in upload mode.
     */
    async persistPendingGeminiRecords(pendingRecords: PendingGeminiRecord[], messageId: string): Promise<void> {
        if (pendingRecords.length === 0) return;

        if (!this.geminiFileRepo || !this.uploaderRegistry || !this.freeKeyProvider) {
            throw new Error("Upload mode repository dependencies not injected into AgentMessageBuilder");
        }

        const geminiFileRepo = this.geminiFileRepo;
        // Resolve the uploader for whichever key is currently active — must be read at call
        // time rather than captured at construction so it tracks round-robin rotation.
        const uploader = this.uploaderRegistry.get(this.freeKeyProvider.currentKey.id);

        const savedFiles = await geminiFileRepo.saveFiles(
            pendingRecords.map(({ fileAnchor }) => ({ ...fileAnchor, messageId })),
        );

        await geminiFileRepo.upsertUploads(
            savedFiles.map((savedFile, i) => ({
                geminiFileId: savedFile.id,
                apiKeyId: uploader.apiKeyId,
                // biome-ignore lint/style/noNonNullAssertion: index is always in-bounds (same-length arrays)
                ...pendingRecords[i]!.uploadData,
            })),
        );
    }

    /**
     * Inline mode: builds message content parts with Discord token URL media blocks.
     *
     * Instead of downloading files and embedding raw base64 (which bloats Postgres),
     * each attachment or embed media item is encoded as a `discord://` token URL.
     * The actual bytes are fetched on demand by {@link normalizeInlineMediaBlocks}
     * just before the message is passed to the LLM.
     *
     * MIME type is resolved eagerly from Discord metadata so the block is complete
     * enough for size-budget checks without requiring a network round-trip.
     */
    private async buildInlineModeContentParts(
        content: string,
        attachments: IChatClientMessageAttachment[],
        embeds?: IChatClientMessageEmbed[],
        guildId?: string,
        channelId?: string,
        discordMessageId?: string,
    ): Promise<Array<{ type: "text"; text: string } | { type: "media"; mimeType: string; url: string }>> {
        return Sentry.startSpan(
            {
                name: "Build inline attachment message",
                op: "app.attachments.build_inline",
                attributes: { "app.attachment_count": attachments.length },
            },
            () => {
                const mediaBlocks: Array<{ type: "media"; mimeType: string; url: string }> = [];

                for (const attachment of attachments) {
                    const mimeType = attachment.contentType ?? "application/octet-stream";
                    const tokenUrl =
                        guildId && channelId && discordMessageId
                            ? buildAttachmentTokenUrl(guildId, channelId, discordMessageId, attachment.id)
                            : attachment.url;
                    mediaBlocks.push({ type: "media", mimeType, url: tokenUrl });
                }

                if (embeds) {
                    for (const [embedIndex, embed] of embeds.entries()) {
                        for (const key of EMBED_MEDIA_KEYS) {
                            const media = embed[key];
                            if (!media?.url) continue;
                            const tokenUrl =
                                guildId && channelId && discordMessageId
                                    ? buildEmbedTokenUrl(guildId, channelId, discordMessageId, embedIndex, key)
                                    : media.url;
                            // MIME type is not available from embed metadata; resolved on download
                            mediaBlocks.push({ type: "media", mimeType: "application/octet-stream", url: tokenUrl });
                        }
                    }
                }

                this.logger.debug({ count: mediaBlocks.length }, "Built inline media token blocks (download deferred)");

                // Use legacy LangChain media format with type: "media" rather than specific
                // block types (e.g. "image", "file") via the contentBlocks constructor.
                // See HandleDiscordMessage for detailed rationale.
                return Promise.resolve([
                    ...(content ? [{ type: "text" as const, text: content }] : []),
                    ...mediaBlocks,
                ]);
            },
        );
    }

    /**
     * Upload mode: streams each attachment and embed media item directly to the Gemini
     * Files API (no temp file on disk), then returns content parts with Gemini URL
     * references and pending Gemini records.
     */
    private async buildUploadModeContentParts(
        content: string,
        attachments: IChatClientMessageAttachment[],
        embeds?: IChatClientMessageEmbed[],
    ): Promise<{
        contentParts: Array<{ type: "text"; text: string } | { type: "media"; mimeType: string; fileUri: string }>;
        pendingRecords: PendingGeminiRecord[];
    }> {
        return Sentry.startSpan(
            {
                name: "Build upload-mode attachment message",
                op: "app.attachments.build_upload",
                attributes: { "app.attachment_count": attachments.length },
            },
            async () => {
                if (!this.streamingDownloader || !this.uploaderRegistry || !this.freeKeyProvider) {
                    throw new Error("Upload mode dependencies not injected into AgentMessageBuilder");
                }

                // Destructure to satisfy TypeScript narrowing after the undefined guard above.
                const { streamingDownloader, uploaderRegistry, freeKeyProvider } = this;

                const uploadedParts: Array<{
                    type: "media";
                    mimeType: string;
                    fileUri: string;
                }> = [];
                const pendingRecords: PendingGeminiRecord[] = [];

                for (const attachment of attachments) {
                    const { stream, mimeType, byteLength } = await streamingDownloader.downloadStream(attachment);

                    const fileName = `files/${randomUUIDv7()}`;
                    const uploaded = await uploaderRegistry
                        .get(freeKeyProvider.currentKey.id)
                        .uploadStream(stream, fileName, mimeType, attachment.name, byteLength ?? attachment.size);

                    this.logger.debug(
                        { name: attachment.name, geminiFileName: uploaded.geminiFileName, mimeType },
                        "Uploaded attachment to Gemini Files API",
                    );

                    pendingRecords.push({
                        fileAnchor: {
                            originalGeminiUrl: uploaded.geminiUrl,
                            sourceType: GeminiFileSourceType.ATTACHMENT,
                            discordAttachmentId: attachment.id,
                            discordFilename: attachment.name,
                            embedIndex: null,
                            embedMediaKey: null,
                        },
                        uploadData: {
                            geminiFileName: uploaded.geminiFileName,
                            geminiUrl: uploaded.geminiUrl,
                            uploadedAt: new Date(),
                        },
                    });

                    uploadedParts.push({ type: "media", mimeType, fileUri: uploaded.geminiUrl });
                }

                if (embeds) {
                    for (const [embedIndex, embed] of embeds.entries()) {
                        for (const key of EMBED_MEDIA_KEYS) {
                            const media = embed[key];
                            if (!media?.url) continue;

                            const capitalizedKey = (key.charAt(0).toUpperCase() + key.slice(1)) as Capitalize<
                                typeof key
                            >;
                            const displayName = `Embed-${embedIndex}-${capitalizedKey}`;
                            try {
                                const embedAttachment: IChatClientMessageAttachment = {
                                    id: media.url,
                                    url: media.url,
                                    // TODO: respect the nullability, work with null at consumer side
                                    proxyURL: media.proxyURL ?? media.url,
                                    name: displayName,
                                    size: 0,
                                    contentType: null,
                                };
                                const acceptTypes = key === "video" ? "video/*" : "image/*";
                                const { stream, mimeType, byteLength } = await streamingDownloader.downloadStream(
                                    embedAttachment,
                                    acceptTypes,
                                );

                                const fileName = `files/${randomUUIDv7()}`;
                                const uploaded = await uploaderRegistry
                                    .get(freeKeyProvider.currentKey.id)
                                    .uploadStream(stream, fileName, mimeType, displayName, byteLength ?? 0);

                                this.logger.debug(
                                    { embedIndex, key, geminiFileName: uploaded.geminiFileName, mimeType },
                                    "Uploaded embed media to Gemini Files API",
                                );

                                pendingRecords.push({
                                    fileAnchor: {
                                        originalGeminiUrl: uploaded.geminiUrl,
                                        sourceType: GeminiFileSourceType.EMBED_MEDIA,
                                        discordAttachmentId: null,
                                        discordFilename: null,
                                        embedIndex,
                                        embedMediaKey: key,
                                    },
                                    uploadData: {
                                        geminiFileName: uploaded.geminiFileName,
                                        geminiUrl: uploaded.geminiUrl,
                                        uploadedAt: new Date(),
                                    },
                                });

                                uploadedParts.push({ type: "media", mimeType, fileUri: uploaded.geminiUrl });
                            } catch (err) {
                                this.logger.warn(
                                    { err, embedIndex, key, url: media.url },
                                    "Failed to download or upload embed media — skipping",
                                );
                            }
                        }
                    }
                }

                return {
                    contentParts: [...(content ? [{ type: "text" as const, text: content }] : []), ...uploadedParts],
                    pendingRecords,
                };
            },
        );
    }
}
