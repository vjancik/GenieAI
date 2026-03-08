import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { GeminiFileUpload } from "../domain/message/GeminiFileUpload.ts";
import type { IMessageRepository } from "../domain/message/IMessageRepository.ts";
import type { AppConfig } from "./config/AppConfig.ts";
import type { GeminiFileRefreshService } from "./GeminiFileRefreshService.ts";
import type { IAgentOrchestrator } from "./ports/IAgentOrchestrator.ts";
import type {
    DiscordAttachmentInfo,
    IAttachmentDownloader,
} from "./ports/IAttachmentDownloader.ts";
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
 * Application use case: handle an incoming Discord @mention.
 *
 * Coordinates:
 * 1. Fetching prior conversation history from the reply chain
 * 2. (upload mode) Refreshing any stale Gemini file references in history
 * 3. Downloading and building a multimodal HumanMessage (inline or upload mode)
 * 4. Invoking the LLM orchestrator with history + current message
 * 5. Persisting the user's message to the database
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
        private readonly geminiFileRefreshService?: GeminiFileRefreshService,
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
    }): Promise<{ response: string; newMessages: BaseMessage[] }> {
        if (this.attachmentMode === "inline") {
            // Guard: reject if total attachment size exceeds the configured limit
            if (params.attachments.length > 0) {
                const totalBytes = params.attachments.reduce(
                    (sum, a) => sum + a.size,
                    0,
                );
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

        let history = this.orchestrator.buildHistory(dbHistory);

        // In upload mode: refresh any stale Gemini file references before invoking the LLM
        if (
            this.attachmentMode === "upload" &&
            this.geminiFileRefreshService &&
            params.attachmentRefetcher &&
            history.length > 0
        ) {
            history = await this.geminiFileRefreshService.refreshHistory(
                history,
                params.attachmentRefetcher,
            );
        }

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
        const { humanMsg, pendingGeminiRecords } = await this.buildHumanMessage(
            params.discordMessageId,
            params.userContent,
            params.attachments,
            params.onStatusUpdate,
        );

        // Persist the user's message first so gemini_file_uploads FK is satisfied.
        await this.messageRepo.save({
            discordMessageId: params.discordMessageId,
            repliesToDiscordId: params.referencedMessageId,
            channelId: params.channelId,
            guildId: params.guildId,
            role: "human",
            // TYPE COERCION: BaseMessage.toJSON() returns LangChain's internal Serialized type,
            // which is incompatible with our DB schema's Record<string, unknown>. Double cast
            // through unknown bridges the gap — the serialized shape IS a plain JSON object.
            langchainMessages: [
                humanMsg.toJSON() as unknown as Record<string, unknown>,
            ],
        });

        // Save gemini file upload records after the message row exists.
        for (const record of pendingGeminiRecords) {
            await this.geminiFileRepo?.save(record);
        }

        // Generate the AI response; collect all new messages for persistence
        const { content, newMessages } = await this.orchestrator.process(
            history,
            humanMsg,
            params.onStatusUpdate,
        );

        return { response: content, newMessages };
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
        await this.messageRepo.save({
            discordMessageId: params.botDiscordMessageId,
            repliesToDiscordId: params.repliesToDiscordId,
            channelId: params.channelId,
            guildId: params.guildId,
            role: "assistant",
            // TYPE COERCION: BaseMessage.toJSON() returns LangChain's internal Serialized type,
            // which is incompatible with our DB schema's Record<string, unknown>. Double cast
            // through unknown bridges the gap — the serialized shape IS a plain JSON object.
            langchainMessages: params.newMessages.map(
                (m) => m.toJSON() as unknown as Record<string, unknown>,
            ),
        });

        this.logger.debug(
            {
                botDiscordMessageId: params.botDiscordMessageId,
                messageCount: params.newMessages.length,
            },
            "Saved bot response to database",
        );
    }

    /**
     * Constructs a HumanMessage from user text and optional file attachments.
     * Delegates to the appropriate builder based on the configured attachment mode.
     *
     * If there are no attachments, always returns a simple string-content HumanMessage.
     *
     * In upload mode, also returns `pendingGeminiRecords` — Gemini file upload rows
     * that must be saved to the DB **after** the user message row exists (FK constraint).
     * In all other modes `pendingGeminiRecords` is always an empty array.
     */
    private async buildHumanMessage(
        discordMessageId: string,
        userContent: string,
        attachments: DiscordAttachmentInfo[],
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<{
        humanMsg: HumanMessage;
        pendingGeminiRecords: Omit<GeminiFileUpload, "id">[];
    }> {
        if (attachments.length === 0) {
            return {
                humanMsg: new HumanMessage(userContent),
                pendingGeminiRecords: [],
            };
        }

        onStatusUpdate?.({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS });

        if (this.attachmentMode === "upload") {
            return this.buildUploadModeMessage(
                discordMessageId,
                userContent,
                attachments,
            );
        }

        const humanMsg = await this.buildInlineModeMessage(
            userContent,
            attachments,
        );
        return { humanMsg, pendingGeminiRecords: [] };
    }

    /**
     * Inline mode: downloads each attachment to memory as base64, embeds directly in message.
     */
    private async buildInlineModeMessage(
        userContent: string,
        attachments: DiscordAttachmentInfo[],
    ): Promise<HumanMessage> {
        const downloaded = await Promise.all(
            attachments.map(
                this.attachmentDownloader.download.bind(
                    this.attachmentDownloader,
                ),
            ),
        );

        this.logger.debug(
            { count: downloaded.length, names: downloaded.map((d) => d.name) },
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
            | { type: "text"; text: string }
            | { type: "media"; mimeType: string; data: string }
        > = [
            ...(userContent
                ? [{ type: "text" as const, text: userContent }]
                : []),
            ...downloaded.map((d) => ({
                type: "media" as const,
                mimeType: d.mimeType,
                data: d.data,
            })),
        ];

        return new HumanMessage({ content: contentParts });
    }

    /**
     * Upload mode: streams each attachment to a temp file, uploads to Gemini Files API,
     * then builds a message with Gemini URL references.
     *
     * Temp files are deleted in a try/finally after each upload.
     * Gemini file upload records are NOT saved here — they are returned as
     * `pendingGeminiRecords` so that `handle()` can persist them after the user
     * message row exists (required to satisfy the FK constraint).
     */
    private async buildUploadModeMessage(
        discordMessageId: string,
        userContent: string,
        attachments: DiscordAttachmentInfo[],
    ): Promise<{
        humanMsg: HumanMessage;
        pendingGeminiRecords: Omit<GeminiFileUpload, "id">[];
    }> {
        if (!this.diskDownloader || !this.geminiFileUploader) {
            throw new Error(
                "Upload mode dependencies not injected into HandleDiscordMention",
            );
        }

        // Legacy LangChain media format for file references — uses fileUri instead of data.
        // See buildInlineModeMessage comment above for why we use type: "media" and
        // content: rather than contentBlocks: with specific KNOWN_BLOCK_TYPES values.
        const uploadedParts: Array<{
            type: "media";
            mimeType: string;
            fileUri: string;
        }> = [];
        const pendingGeminiRecords: Omit<GeminiFileUpload, "id">[] = [];

        for (const attachment of attachments) {
            const tempPath = join(
                UPLOAD_TEMP_DIR,
                `${randomUUID()}-${attachment.name}`,
            );
            try {
                const mimeType = await this.diskDownloader.downloadToFile(
                    attachment,
                    tempPath,
                );

                const fileName = `files/${randomUUID()}`;
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

                // Collect the record; it will be saved by handle() after the message row exists.
                // originalGeminiUrl = geminiUrl on first upload — this is the immutable lookup key.
                pendingGeminiRecords.push({
                    originalGeminiUrl: uploaded.geminiUrl,
                    geminiFileName: uploaded.geminiFileName,
                    geminiUrl: uploaded.geminiUrl,
                    uploadedAt: new Date(),
                    discordAttachmentId: attachment.id,
                    discordFilename: attachment.name,
                    messageDiscordId: discordMessageId,
                });

                uploadedParts.push({
                    type: "media",
                    mimeType,
                    fileUri: uploaded.geminiUrl,
                });
            } finally {
                await unlink(tempPath).catch((err) => {
                    this.logger.warn(
                        { tempPath, err },
                        "Failed to delete temp file after Gemini upload",
                    );
                });
            }
        }

        const contentParts: Array<
            | { type: "text"; text: string }
            | { type: "media"; mimeType: string; fileUri: string }
        > = [
            ...(userContent
                ? [{ type: "text" as const, text: userContent }]
                : []),
            ...uploadedParts,
        ];

        return {
            humanMsg: new HumanMessage({ content: contentParts }),
            pendingGeminiRecords,
        };
    }
}
