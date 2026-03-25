import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import { randomUUIDv7 } from "bun";
import { EMBED_MEDIA_KEYS, type GeminiFile, GeminiFileSourceType } from "../../domain/message/GeminiFile.ts";
import { type AppConfig, AttachmentMode } from "../config/AppConfig.ts";
import type { IChatClientMessageAttachment, IChatClientMessageEmbed } from "../ports/chat/IChatClient.ts";
import type { IAttachmentDownloader } from "../ports/IAttachmentDownloader.ts";
import type { IDiskAttachmentDownloader } from "../ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "../ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploaderRegistry } from "../ports/IGeminiFileUploaderRegistry.ts";
import type { IRoundRobinKeyProvider } from "../ports/IRoundRobinKeyProvider.ts";
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
    private readonly attachmentsTempDir: string;

    /**
     * @param attachmentDownloader - Downloads attachments in inline mode
     * @param logger - Logger instance
     * @param config - Application config subset for file/attachment settings
     * @param diskDownloader - Required in upload mode; streams files to a temp path
     * @param uploaderRegistry - Required in upload mode; provides uploaders keyed by API key ID
     * @param freeKeyProvider - Required in upload mode; supplies the currently active API key
     * @param geminiFileRepo - Required in upload mode; persists Gemini file metadata
     */
    constructor(
        private readonly attachmentDownloader: IAttachmentDownloader,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
        /** Required in upload mode; unused in inline mode. */
        private readonly diskDownloader?: IDiskAttachmentDownloader,
        private readonly uploaderRegistry?: IGeminiFileUploaderRegistry,
        private readonly freeKeyProvider?: IRoundRobinKeyProvider,
        private readonly geminiFileRepo?: IGeminiFileRepository,
    ) {
        this.maxInlineBytes = config.file.agent.maxInlineAttachmentSizeBytes;
        this.attachmentMode = config.file.agent.uploadAttachmentMode;
        this.attachmentsTempDir = config.file.attachmentDownloader.tempDir;
    }

    /**
     * Constructs a LangChain message from content and optional file attachments.
     * Produces a {@link HumanMessage} for role "human" and an {@link AIMessage} for role "assistant".
     */
    async buildMessage<R extends "human" | "assistant">(params: {
        role: R;
        content: string;
        attachments: IChatClientMessageAttachment[];
        embeds?: IChatClientMessageEmbed[];
        onStatusUpdate?: OnStatusUpdate;
    }): Promise<{
        msg: R extends "human" ? HumanMessage : AIMessage;
        pendingRecords: PendingGeminiRecord[];
    }> {
        const { role, content, attachments, embeds, onStatusUpdate } = params;

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

        const contentParts = await this.buildInlineModeContentParts(content, attachments, embeds);
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
     * Inline mode: downloads each attachment and embed media item to memory as base64,
     * embeds directly in message content parts.
     */
    private async buildInlineModeContentParts(
        content: string,
        attachments: IChatClientMessageAttachment[],
        embeds?: IChatClientMessageEmbed[],
    ): Promise<Array<{ type: "text"; text: string } | { type: "media"; mimeType: string; data: string }>> {
        return Sentry.startSpan(
            {
                name: "Build inline attachment message",
                op: "app.attachments.build_inline",
                attributes: { "app.attachment_count": attachments.length },
            },
            async () => {
                const embedMediaItems: { attachment: IChatClientMessageAttachment; acceptTypes: string }[] = [];
                if (embeds) {
                    for (const [embedIndex, embed] of embeds.entries()) {
                        for (const key of EMBED_MEDIA_KEYS) {
                            const media = embed[key];
                            if (!media?.url) continue;
                            const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
                            embedMediaItems.push({
                                attachment: {
                                    id: media.url,
                                    url: media.url,
                                    proxyURL: media.proxyURL ?? media.url,
                                    name: `Embed-${embedIndex}-${capitalizedKey}`,
                                    size: 0,
                                    contentType: null,
                                },
                                acceptTypes: key === "video" ? "video/*" : "image/*",
                            });
                        }
                    }
                }

                const attachmentsPromise = Promise.all(attachments.map((a) => this.attachmentDownloader.download(a)));
                const embedsPromise = Promise.allSettled(
                    embedMediaItems.map(({ attachment, acceptTypes }) =>
                        this.attachmentDownloader.download(attachment, acceptTypes),
                    ),
                );
                const [downloadedAttachments, embedResults] = await Promise.all([attachmentsPromise, embedsPromise]);
                const downloadedEmbeds = embedResults.flatMap((result, i) => {
                    if (result.status === "fulfilled") return [result.value];
                    this.logger.warn(
                        {
                            err: result.reason,
                            name: embedMediaItems[i]?.attachment.name,
                            url: embedMediaItems[i]?.attachment.url,
                        },
                        "Failed to download embed media for inline embedding — skipping",
                    );
                    return [];
                });

                const downloaded = [...downloadedAttachments, ...downloadedEmbeds];

                this.logger.debug(
                    { count: downloaded.length, names: downloaded.map((d) => d.name) },
                    "Downloaded attachments for inline embedding",
                );

                // Use legacy LangChain media format with type: "media" rather than specific
                // block types (e.g. "image", "file") via the contentBlocks constructor.
                // See HandleDiscordMessage for detailed rationale.
                return [
                    ...(content ? [{ type: "text" as const, text: content }] : []),
                    ...downloaded.map((d) => ({
                        type: "media" as const,
                        mimeType: d.mimeType,
                        data: d.data,
                    })),
                ];
            },
        );
    }

    /**
     * Upload mode: streams each attachment and embed media item to a temp file, uploads
     * to Gemini Files API, then returns content parts with Gemini URL references and
     * pending Gemini records.
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
                if (!this.diskDownloader || !this.uploaderRegistry || !this.freeKeyProvider) {
                    throw new Error("Upload mode dependencies not injected into AgentMessageBuilder");
                }

                // Destructure to satisfy TypeScript narrowing after the undefined guard above.
                const { uploaderRegistry, freeKeyProvider } = this;

                const uploadedParts: Array<{
                    type: "media";
                    mimeType: string;
                    fileUri: string;
                }> = [];
                const pendingRecords: PendingGeminiRecord[] = [];

                for (const attachment of attachments) {
                    const tempPath = join(this.attachmentsTempDir, `${randomUUIDv7()}-${attachment.name}`);
                    try {
                        const mimeType = await this.diskDownloader.downloadToFile(attachment, tempPath);

                        const fileName = `files/${randomUUIDv7()}`;
                        const uploaded = await uploaderRegistry
                            .get(freeKeyProvider.currentKey.id)
                            .upload(tempPath, fileName, mimeType, attachment.name);

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
                    } finally {
                        await unlink(tempPath).catch((err) => {
                            this.logger.warn({ tempPath, err }, "Failed to delete temp file after Gemini upload");
                        });
                    }
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
                            const tempPath = join(this.attachmentsTempDir, `${randomUUIDv7()}-${displayName}`);
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
                                const mimeType = await this.diskDownloader.downloadToFile(
                                    embedAttachment,
                                    tempPath,
                                    acceptTypes,
                                );

                                const fileName = `files/${randomUUIDv7()}`;
                                const uploaded = await uploaderRegistry
                                    .get(freeKeyProvider.currentKey.id)
                                    .upload(tempPath, fileName, mimeType, displayName);

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
                            } finally {
                                await unlink(tempPath).catch((unlinkErr) => {
                                    this.logger.warn(
                                        { tempPath, err: unlinkErr },
                                        "Failed to delete temp embed media file after Gemini upload",
                                    );
                                });
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
