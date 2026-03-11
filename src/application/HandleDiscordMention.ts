import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { GeminiFile } from "../domain/message/GeminiFile.ts";
import type { IMessageRepository } from "../domain/message/IMessageRepository.ts";
import type { AppConfig } from "./config/AppConfig.ts";
import type { IAgentOrchestrator } from "./ports/IAgentOrchestrator.ts";
import type { DiscordAttachmentInfo, IAttachmentDownloader } from "./ports/IAttachmentDownloader.ts";
import type { IDiscordAttachmentRefetcher } from "./ports/IDiscordAttachmentRefetcher.ts";
import type { IDiskAttachmentDownloader } from "./ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "./ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploader } from "./ports/IGeminiFileUploader.ts";
import type { OnStatusUpdate } from "./types/AgentStatus.ts";
import { AgentStatusType } from "./types/AgentStatus.ts";
import type { Logger } from "./types/Logger.ts";

/** Temp directory for streaming attachments before Gemini upload. */
const UPLOAD_TEMP_DIR = "/var/tmp/genie-attachments";

/**
 * Pending data for a single Gemini file upload that must be persisted after
 * the user message row exists (satisfies the `gemini_files.message_discord_id`
 * FK constraint).
 *
 * Split into two parts for the two-phase save:
 * - `fileAnchor` → inserted into `gemini_files` (permanent, idempotent)
 * - `uploadData` → upserted into `gemini_file_uploads` (ephemeral, per-key)
 */
type PendingGeminiRecord = {
    fileAnchor: Omit<GeminiFile, "id">;
    uploadData: {
        geminiFileName: string;
        geminiUrl: string;
        uploadedAt: Date;
    };
};

/**
 * Application use case: handle an incoming Discord @mention.
 *
 * Coordinates:
 * 1. Fetching prior conversation history from the reply chain
 * 2. Downloading and building a multimodal HumanMessage (inline or upload mode)
 * 3. Invoking the LLM orchestrator with history + current message
 *    (the orchestrator handles Gemini file refresh per key attempt internally)
 * 4. Persisting the user's message to the database
 *
 * The bot's response message is persisted separately (via {@link saveBotResponse})
 * after it has been sent to Discord, because we need Discord's message ID.
 *
 * All messages are serialized using LangChain's BaseMessage.toJSON() to preserve
 * full metadata (thoughtSignatures, tool calls, response_metadata) for context continuity.
 */
export class HandleDiscordMention {
    private readonly maxInlineBytes: number;
    private readonly attachmentMode: AppConfig["attachmentMode"];

    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly orchestrator: IAgentOrchestrator,
        private readonly attachmentDownloader: IAttachmentDownloader,
        private readonly logger: Logger,
        config: Pick<AppConfig, "maxInlineAttachmentSizeMb" | "attachmentMode">,
        /** Required in upload mode; unused in inline mode. */
        private readonly diskDownloader?: IDiskAttachmentDownloader,
        private readonly geminiFileUploader?: IGeminiFileUploader,
        private readonly geminiFileRepo?: IGeminiFileRepository,
    ) {
        this.maxInlineBytes = config.maxInlineAttachmentSizeMb * 1024 * 1024;
        this.attachmentMode = config.attachmentMode;
    }

    /**
     * Process an incoming Discord mention event.
     *
     * @param params.discordMessageId - Discord snowflake for the user's message
     * @param params.referencedMessageId - Discord snowflake of the message being replied to, or null
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake (null for DMs)
     * @param params.userContent - Message content with bot mention stripped
     * @param params.attachments - File attachments on the Discord message
     * @param params.onStatusUpdate - Optional callback forwarded to the orchestrator for live status updates
     * @param params.attachmentRefetcher - Per-request Discord attachment fetcher (required in upload mode)
     * @returns The AI-generated response string and the new LangChain messages generated,
     *          or an error string if attachments exceed the size limit (inline mode only)
     */
    async handle(params: {
        discordMessageId: string;
        referencedMessageId: string | null;
        channelId: string;
        guildId: string | null;
        userContent: string;
        attachments: DiscordAttachmentInfo[];
        onStatusUpdate?: OnStatusUpdate;
        attachmentRefetcher?: IDiscordAttachmentRefetcher;
    }): Promise<{
        response: string;
        newMessages: BaseMessage[];
        isFailure?: boolean;
        isRetryable?: boolean;
    }> {
        try {
            return await Sentry.startSpan(
                {
                    name: "Process Discord mention",
                    op: "app.mention.handle",
                    attributes: {
                        "discord.message_id": params.discordMessageId,
                        "app.attachment_count": params.attachments.length,
                        "app.attachment_mode": this.attachmentMode,
                        "app.has_reply_chain": params.referencedMessageId !== null,
                    },
                },
                async (span) => {
                    if (this.attachmentMode === "inline") {
                        // Guard: reject if total attachment size exceeds the configured limit
                        if (params.attachments.length > 0) {
                            const totalBytes = params.attachments.reduce((sum, a) => sum + a.size, 0);
                            if (totalBytes > this.maxInlineBytes) {
                                const limitMb = this.maxInlineBytes / (1024 * 1024);
                                const actualMb = (totalBytes / (1024 * 1024)).toFixed(1);
                                this.logger.warn(
                                    {
                                        totalBytes,
                                        maxBytes: this.maxInlineBytes,
                                        discordMessageId: params.discordMessageId,
                                    },
                                    "Attachment size exceeds limit — rejecting",
                                );
                                return {
                                    response: `Sorry, your attachments total ${actualMb} MB which exceeds the ${limitMb} MB limit. Please send smaller files.`,
                                    newMessages: [],
                                };
                            }
                        }
                    }

                    // Fetch existing reply chain if this message is a reply
                    const dbHistory =
                        params.referencedMessageId !== null
                            ? await this.messageRepo.fetchChain(params.referencedMessageId)
                            : [];

                    const history = this.orchestrator.buildHistory(dbHistory);

                    span.setAttribute("app.history_length", history.length);

                    this.logger.debug(
                        {
                            discordMessageId: params.discordMessageId,
                            historyLength: history.length,
                            hasReply: params.referencedMessageId !== null,
                            attachmentCount: params.attachments.length,
                            attachmentMode: this.attachmentMode,
                        },
                        "Processing mention with history",
                    );

                    // Build the human message — multimodal if attachments are present.
                    // In upload mode this also returns pending gemini file records that must
                    // be saved AFTER the user's message row exists (FK constraint).
                    const { humanMsg, pendingRecords } = await this.buildHumanMessage(
                        params.discordMessageId,
                        params.userContent,
                        params.attachments,
                        params.onStatusUpdate,
                    );

                    // Persist the user's message first so gemini_files FK is satisfied.
                    await this.messageRepo.save({
                        discordMessageId: params.discordMessageId,
                        repliesToDiscordId: params.referencedMessageId,
                        channelId: params.channelId,
                        guildId: params.guildId,
                        role: "human",
                        // TYPE COERCION: BaseMessage.toJSON() returns LangChain's internal Serialized type,
                        // which is incompatible with our DB schema's Record<string, unknown>. Double cast
                        // through unknown bridges the gap — the serialized shape IS a plain JSON object.
                        langchainMessages: [humanMsg.toJSON() as unknown as Record<string, unknown>],
                    });

                    // Two-phase save for each uploaded attachment:
                    // 1. saveFile — idempotent insert into gemini_files (permanent anchor)
                    // 2. upsertUpload — insert/update gemini_file_uploads (ephemeral per-key record)
                    if (pendingRecords.length > 0) {
                        if (!this.geminiFileRepo || !this.geminiFileUploader) {
                            throw new Error(
                                "Upload mode repository dependencies not injected into HandleDiscordMention",
                            );
                        }
                        const { geminiFileRepo, geminiFileUploader } = this;
                        for (const { fileAnchor, uploadData } of pendingRecords) {
                            // TODO: we might have to delete these files in a catch clause if the handler fails as the originalUrl will never get persisted to langchainMessages and this record will never be selected
                            const savedFile = await geminiFileRepo.saveFile(fileAnchor);
                            await geminiFileRepo.upsertUpload({
                                geminiFileId: savedFile.id,
                                apiKeyId: geminiFileUploader.apiKeyId,
                                ...uploadData,
                            });
                        }
                    }

                    // Generate the AI response; the orchestrator handles Gemini file refresh internally
                    // per key attempt, threaded via attachmentRefetcher in context.
                    const { content, newMessages } = await this.orchestrator.process(
                        history,
                        humanMsg,
                        params.onStatusUpdate,
                        params.attachmentRefetcher,
                    );

                    return { response: content, newMessages };
                },
            );
        } catch (err) {
            this.logger.error({ err, discordMessageId: params.discordMessageId }, "Failed to process mention");
            Sentry.captureException(err);
            return {
                response: "Sorry, I encountered an error processing your request.",
                newMessages: [],
                isFailure: true,
                isRetryable: true,
            };
        }
    }

    /**
     * Persist the bot's reply message after it has been sent to Discord.
     * Must be called after sending the reply so we can capture Discord's assigned message ID.
     *
     * Stores all LangChain messages generated during processing (triage response, tool messages,
     * final response) so the conversation history has no gaps.
     *
     * @param params.botDiscordMessageId - The Discord ID of the sent bot reply
     * @param params.repliesToDiscordId - The Discord ID of the user message this replies to
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake (null for DMs)
     * @param params.newMessages - All LangChain messages generated during this turn
     */
    async saveBotResponse(params: {
        botDiscordMessageId: string;
        repliesToDiscordId: string;
        channelId: string;
        guildId: string | null;
        newMessages: BaseMessage[];
    }): Promise<void> {
        await Sentry.startSpan(
            {
                name: "Save bot response",
                op: "app.mention.save_bot_response",
                attributes: {
                    "discord.message_id": params.botDiscordMessageId,
                    "app.message_count": params.newMessages.length,
                },
            },
            async () => {
                await this.messageRepo.save({
                    discordMessageId: params.botDiscordMessageId,
                    repliesToDiscordId: params.repliesToDiscordId,
                    channelId: params.channelId,
                    guildId: params.guildId,
                    role: "assistant",
                    // TYPE COERCION: BaseMessage.toJSON() returns LangChain's internal Serialized type,
                    // which is incompatible with our DB schema's Record<string, unknown>. Double cast
                    // through unknown bridges the gap — the serialized shape IS a plain JSON object.
                    langchainMessages: params.newMessages.map((m) => m.toJSON() as unknown as Record<string, unknown>),
                });

                this.logger.debug(
                    {
                        botDiscordMessageId: params.botDiscordMessageId,
                        messageCount: params.newMessages.length,
                    },
                    "Saved bot response to database",
                );
            },
        );
    }

    /**
     * Constructs a HumanMessage from user text and optional file attachments.
     * Delegates to the appropriate builder based on the configured attachment mode.
     *
     * If there are no attachments, always returns a simple string-content HumanMessage.
     *
     * In upload mode, also returns `pendingRecords` — split GeminiFile + upload data
     * that must be saved to the DB **after** the user message row exists (FK constraint).
     * In all other modes `pendingRecords` is always an empty array.
     */
    private async buildHumanMessage(
        discordMessageId: string,
        userContent: string,
        attachments: DiscordAttachmentInfo[],
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<{
        humanMsg: HumanMessage;
        pendingRecords: PendingGeminiRecord[];
    }> {
        if (attachments.length === 0) {
            return {
                humanMsg: new HumanMessage(userContent),
                pendingRecords: [],
            };
        }

        onStatusUpdate?.({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS });

        if (this.attachmentMode === "upload") {
            return this.buildUploadModeMessage(discordMessageId, userContent, attachments);
        }

        const humanMsg = await this.buildInlineModeMessage(userContent, attachments);
        return { humanMsg, pendingRecords: [] };
    }

    /**
     * Inline mode: downloads each attachment to memory as base64, embeds directly in message.
     */
    private async buildInlineModeMessage(
        userContent: string,
        attachments: DiscordAttachmentInfo[],
    ): Promise<HumanMessage> {
        return Sentry.startSpan(
            {
                name: "Build inline attachment message",
                op: "app.attachments.build_inline",
                attributes: { "app.attachment_count": attachments.length },
            },
            async () => {
                const downloaded = await Promise.all(
                    attachments.map(this.attachmentDownloader.download.bind(this.attachmentDownloader)),
                );

                this.logger.debug(
                    {
                        count: downloaded.length,
                        names: downloaded.map((d) => d.name),
                    },
                    "Downloaded attachments for inline embedding",
                );

                // Use legacy LangChain media format with type: "media" rather than specific
                // block types (e.g. "image", "file") via the contentBlocks constructor.
                // The v1/contentBlocks path's convertStandardContentBlockToGeminiPart only handles
                // "image", "video", "audio" — not "file" or "text-plain" (both in KNOWN_BLOCK_TYPES).
                // An attachment-only message (no text) using an unsupported type returns null for all
                // blocks and is silently dropped from the Gemini contents array.
                // The legacy path handles { type: "media" } correctly via isMessageContentMedia.
                const contentParts: Array<
                    { type: "text"; text: string } | { type: "media"; mimeType: string; data: string }
                > = [
                    ...(userContent ? [{ type: "text" as const, text: userContent }] : []),
                    ...downloaded.map((d) => ({
                        type: "media" as const,
                        mimeType: d.mimeType,
                        data: d.data,
                    })),
                ];

                return new HumanMessage({ content: contentParts });
            },
        );
    }

    /**
     * Upload mode: streams each attachment to a temp file, uploads to Gemini Files API,
     * then builds a message with Gemini URL references.
     *
     * Temp files are deleted in a try/finally after each upload.
     * Gemini file records are NOT saved here — they are returned as `pendingRecords`
     * so that `handle()` can persist them after the user message row exists
     * (required to satisfy the `gemini_files.message_discord_id` FK constraint).
     */
    private async buildUploadModeMessage(
        discordMessageId: string,
        userContent: string,
        attachments: DiscordAttachmentInfo[],
    ): Promise<{
        humanMsg: HumanMessage;
        pendingRecords: PendingGeminiRecord[];
    }> {
        return Sentry.startSpan(
            {
                name: "Build upload-mode attachment message",
                op: "app.attachments.build_upload",
                attributes: { "app.attachment_count": attachments.length },
            },
            async () => {
                if (!this.diskDownloader || !this.geminiFileUploader) {
                    throw new Error("Upload mode dependencies not injected into HandleDiscordMention");
                }

                // Legacy LangChain media format for file references — uses fileUri instead of data.
                // See buildInlineModeMessage comment above for why we use type: "media" and
                // content: rather than contentBlocks: with specific KNOWN_BLOCK_TYPES values.
                const uploadedParts: Array<{
                    type: "media";
                    mimeType: string;
                    fileUri: string;
                }> = [];
                const pendingRecords: PendingGeminiRecord[] = [];

                for (const attachment of attachments) {
                    const tempPath = join(UPLOAD_TEMP_DIR, `${Bun.randomUUIDv7()}-${attachment.name}`);
                    try {
                        const mimeType = await this.diskDownloader.downloadToFile(attachment, tempPath);

                        const fileName = `files/${Bun.randomUUIDv7()}`;
                        const uploaded = await this.geminiFileUploader.upload(
                            tempPath,
                            fileName,
                            mimeType,
                            attachment.name,
                        );

                        this.logger.debug(
                            {
                                name: attachment.name,
                                geminiFileName: uploaded.geminiFileName,
                                mimeType,
                            },
                            "Uploaded attachment to Gemini Files API",
                        );

                        // Collect the split record; saved by handle() after the message row exists.
                        // originalGeminiUrl = geminiUrl on first upload — this is the immutable lookup key
                        // stored in LangChain content blocks and used by GeminiFileRefreshService.
                        pendingRecords.push({
                            fileAnchor: {
                                originalGeminiUrl: uploaded.geminiUrl,
                                discordAttachmentId: attachment.id,
                                discordFilename: attachment.name,
                                messageDiscordId: discordMessageId,
                            },
                            uploadData: {
                                geminiFileName: uploaded.geminiFileName,
                                geminiUrl: uploaded.geminiUrl,
                                uploadedAt: new Date(),
                            },
                        });

                        uploadedParts.push({
                            type: "media",
                            mimeType,
                            fileUri: uploaded.geminiUrl,
                        });
                    } finally {
                        await unlink(tempPath).catch((err) => {
                            this.logger.warn({ tempPath, err }, "Failed to delete temp file after Gemini upload");
                        });
                    }
                }

                const contentParts: Array<
                    { type: "text"; text: string } | { type: "media"; mimeType: string; fileUri: string }
                > = [...(userContent ? [{ type: "text" as const, text: userContent }] : []), ...uploadedParts];

                return {
                    humanMsg: new HumanMessage({ content: contentParts }),
                    pendingRecords,
                };
            },
        );
    }
}
