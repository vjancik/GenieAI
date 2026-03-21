import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import { randomUUIDv7 } from "bun";
import { extractDisplayMessage } from "../../domain/errors/AppError.ts";
import type { GeminiFile } from "../../domain/message/GeminiFile.ts";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import type { DiscordMessage } from "../../domain/message/Message.ts";
import type { MessageIntent } from "../../domain/message/MessageIntent.ts";
import { type AppConfig, AttachmentMode } from "../config/AppConfig.ts";
import { discordMessageToLlmText } from "../formatters/textTransformers.ts";
import type { IAgentOrchestrator } from "../ports/IAgentOrchestrator.ts";
import type { DiscordAttachmentInfo, IAttachmentDownloader } from "../ports/IAttachmentDownloader.ts";
import type { DiscordMessageSnapshot, IChatMessageService } from "../ports/IChatMessageService.ts";
import type { IDiskAttachmentDownloader } from "../ports/IDiskAttachmentDownloader.ts";
import type { IGeminiFileRepository } from "../ports/IGeminiFileRepository.ts";
import type { IGeminiFileUploader } from "../ports/IGeminiFileUploader.ts";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";
import { AgentStatusType } from "../types/AgentStatus.ts";
import type { Logger } from "../types/Logger.ts";

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
    /**
     * fileAnchor excludes id, messageId, discordMessageId, and discordChannelId.
     * messageId is filled in after the message row is saved (FK requires UUID PK).
     * discordMessageId and discordChannelId are NOT stored on gemini_files — they
     * are sourced at read time from the joined messages row.
     */
    fileAnchor: Omit<GeminiFile, "id" | "messageId" | "discordMessageId" | "discordChannelId">;
    uploadData: {
        geminiFileName: string;
        geminiUrl: string;
        uploadedAt: Date;
    };
};

/**
 * Application use case: handle an incoming Discord message.
 *
 * Coordinates:
 * 1. Fetching prior conversation history from the reply chain
 * 2. Downloading and building a multimodal HumanMessage or AIMessage (inline or upload mode)
 * 3. Invoking the LLM orchestrator with history + current message
 *    (the orchestrator handles Gemini file refresh per key attempt internally)
 * 4. Persisting the user's message to the database
 *
 * If the DB reply chain is empty but a referencedMessageId exists, falls back to
 * live-fetching the full Discord reply chain via {@link IChatMessageService}, batch-persisting
 * all missing messages (with full Gemini upload treatment), and re-fetching from DB.
 *
 * The bot's response message is persisted separately via {@link IMessageRepository.saveAssistantMessage}
 * after it has been sent to Discord, because we need Discord's message ID.
 *
 * All messages are serialized using LangChain's BaseMessage.toJSON() to preserve
 * full metadata (thoughtSignatures, tool calls, response_metadata) for context continuity.
 */
export class HandleDiscordMessageUseCase {
    private readonly maxInlineBytes: number;
    private readonly attachmentMode: AttachmentMode;
    private readonly attachmentsTempDir: string;

    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly orchestrator: IAgentOrchestrator,
        private readonly attachmentDownloader: IAttachmentDownloader,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
        /** Required in upload mode; unused in inline mode. */
        private readonly diskDownloader?: IDiskAttachmentDownloader,
        private readonly geminiFileUploader?: IGeminiFileUploader,
        private readonly geminiFileRepo?: IGeminiFileRepository,
        private readonly chatMessageService?: IChatMessageService,
    ) {
        this.maxInlineBytes = config.file.agent.maxInlineAttachmentSizeMB * 1024 * 1024;
        this.attachmentMode = config.file.agent.uploadAttachmentMode;
        this.attachmentsTempDir = config.file.attachmentsTempDir;
    }

    /**
     * Process an incoming Discord message.
     *
     * @param params.discordMessageId - Discord snowflake for the user's message
     * @param params.referencedMessageId - Discord snowflake of the message being replied to, or null
     * @param params.channelId - Discord channel snowflake
     * @param params.guildId - Discord guild snowflake, or "@me" for DMs
     * @param params.userContent - Message content with bot mention stripped
     * @param params.attachments - File attachments on the Discord message
     * @param params.onStatusUpdate - Optional callback forwarded to the orchestrator for live status updates
     * @param params.reuseHumanMessage - When true, skip building and persisting the human message row.
     *   Instead, fetch the chain starting from `discordMessageId` itself and deserialize the human
     *   message from the tail. Use this when the human message row already exists in the DB
     *   (e.g. a retry or a context menu command invoked on a previously-summarized message).
     * @param params.fetchHistory - When true (default), fetch the full reply chain as conversation history.
     *   When false, fetch only the last message (limit: 1). Use this for context menu commands where
     *   only the targeted message is relevant, not a full thread.
     * @param params.ephemeralInstructionMessage - When set, appended as the final user turn passed to
     *   the orchestrator instead of the built message content. The target message's deserialized content
     *   goes into history as context. Never persisted to the DB — use to inject one-off instructions
     *   (e.g. "Summarize this:") without polluting the stored message content.
     * @returns The AI-generated response string and the new LangChain messages generated,
     *          or an error string if attachments exceed the size limit (inline mode only)
     */
    async execute(params: {
        discordMessageId: string;
        referencedMessageId: string | null;
        channelId: string;
        guildId: string;
        /** Discord snowflake of the user who sent this message. Persisted for Retry button authorship checks. */
        discordAuthorId: string;
        userContent: string;
        attachments: DiscordAttachmentInfo[];
        intent: MessageIntent;
        onStatusUpdate?: OnStatusUpdate;
        reuseHumanMessage?: boolean;
        fetchHistory?: boolean;
        ephemeralInstructionMessage?: string;
    }): Promise<{
        response: string;
        newMessages: BaseMessage[];
        isFailure?: boolean;
        isRetryable?: boolean;
        usedFallback?: boolean;
    }> {
        try {
            return await Sentry.startSpan(
                {
                    name: "Process Discord message",
                    op: "app.message.handle",
                    attributes: {
                        "discord.message_id": params.discordMessageId,
                        "app.attachment_count": params.attachments.length,
                        "app.attachment_mode": this.attachmentMode,
                        "app.has_reply_chain": params.referencedMessageId !== null,
                    },
                },
                async (span) => {
                    if (this.attachmentMode === AttachmentMode.inline) {
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

                    let dbHistory: DiscordMessage[];
                    let thisTurnMessage: HumanMessage | undefined;

                    if (params.reuseHumanMessage) {
                        // The human message row already exists in the DB — fetch the full chain
                        // starting from discordMessageId itself (includes history + human message).
                        // This path is used by context menu commands invoked on already-saved messages.
                        // fetchHistory: false → limit: 1 (only the target message, no prior history)
                        const existingChain = await this.messageRepo.fetchChain({
                            startDiscordMessageId: params.discordMessageId,
                            channelId: params.channelId,
                            guildId: params.guildId,
                            limit: params.fetchHistory === false ? 1 : undefined,
                        });

                        const lastMessageRecord = existingChain[existingChain.length - 1];
                        if (!lastMessageRecord) {
                            this.logger.warn(
                                { discordMessageId: params.discordMessageId },
                                "reuseHumanMessage: message not found in DB",
                            );
                            return {
                                response: "Sorry, I could not find the original message.",
                                newMessages: [],
                                isFailure: true,
                                isRetryable: false,
                            };
                        }

                        dbHistory = existingChain;
                    } else {
                        // Fetch existing reply chain if this message is a reply
                        dbHistory =
                            params.referencedMessageId !== null
                                ? await this.messageRepo.fetchChain({
                                      startDiscordMessageId: params.referencedMessageId,
                                      channelId: params.channelId,
                                      guildId: params.guildId,
                                      limit: params.fetchHistory === false ? 1 : undefined,
                                  })
                                : [];

                        // If DB chain is empty but a reply chain exists, fall back to live Discord fetch.
                        // fetchAndPersistLiveChain throws on failure — the outer try/catch will
                        // return a retryable error response to the user.
                        if (dbHistory.length === 0 && params.referencedMessageId !== null && this.chatMessageService) {
                            dbHistory = await this.fetchAndPersistLiveChain(
                                this.chatMessageService,
                                params.referencedMessageId,
                                params.channelId,
                                params.guildId,
                                params.onStatusUpdate,
                                params.fetchHistory === false ? 1 : undefined,
                            );
                        }
                        // Build the current turn's message — multimodal if attachments are present.
                        // In upload mode this also returns pending gemini file records that must
                        // be saved AFTER the user's message row exists (FK constraint).
                        const { msg: builtMsg, pendingRecords } = await this.buildMessage({
                            role: "human",
                            content: params.userContent,
                            attachments: params.attachments,
                            onStatusUpdate: params.onStatusUpdate,
                        });

                        // Persist the user's message first so gemini_files FK is satisfied.
                        const savedUserMsg = await this.messageRepo.save({
                            discordMessageId: params.discordMessageId,
                            repliesToDiscordId: params.referencedMessageId,
                            channelId: params.channelId,
                            guildId: params.guildId,
                            role: "human",
                            discordAuthorId: params.discordAuthorId,
                            // TYPE COERCION: BaseMessage.toJSON() returns LangChain's internal Serialized type,
                            // which is incompatible with our DB schema's Record<string, unknown>. Double cast
                            // through unknown bridges the gap — the serialized shape IS a plain JSON object.
                            langchainMessages: [builtMsg.toJSON() as unknown as Record<string, unknown>],
                            retriesLeft: null,
                            usedFallback: null,
                            interactionType: null,
                            interactionAuthorDiscordId: null,
                        });

                        await this.persistPendingGeminiRecords(pendingRecords, savedUserMsg.id);

                        thisTurnMessage = builtMsg;
                    }

                    const history = this.orchestrator.buildHistory(dbHistory);
                    if (thisTurnMessage) history.push(thisTurnMessage);

                    // If the oldest message in history is not a HumanMessage, Gemini will reject it
                    // (conversations must start with a human turn). Insert a placeholder rather than
                    // converting the existing message — converting an AIMessage with tool calls would
                    // corrupt the tool call chain and cause ToolCallNotFoundError. Empty string content
                    // is dropped by Gemini/LangChain, so a non-empty sentinel is used instead.
                    if (history.length > 0 && !(history[0] instanceof HumanMessage)) {
                        history.unshift(new HumanMessage("<History omitted>"));
                    }

                    // When an ephemeral instruction is provided,
                    // append it as the final user turn (target message content stays in history as context).
                    if (params.ephemeralInstructionMessage)
                        history.push(new HumanMessage(params.ephemeralInstructionMessage));

                    // Guard: the last message must be a HumanMessage for the orchestrator.
                    // This should not occur in normal operation — callers are expected to ensure
                    // either thisTurnMessage or ephemeralInstructionMessage provides a human turn.
                    // Spreads all base message fields to preserve content and metadata.
                    const lastMessage = history[history.length - 1];
                    if (lastMessage && !(lastMessage instanceof HumanMessage)) {
                        this.logger.error(
                            {
                                discordMessageId: params.discordMessageId,
                                lastMessageType: lastMessage.constructor.name,
                                reuseHumanMessage: params.reuseHumanMessage,
                                hasEphemeralInstruction: !!params.ephemeralInstructionMessage,
                            },
                            "Last history message is not a HumanMessage — forcefully converting (programmatic error)",
                        );
                        history[history.length - 1] = new HumanMessage({ ...lastMessage });
                    }

                    span.setAttribute("app.history_length", history.length);

                    this.logger.debug(
                        {
                            discordMessageId: params.discordMessageId,
                            historyLength: history.length,
                            hasReply: params.referencedMessageId !== null,
                            attachmentCount: params.attachments.length,
                            attachmentMode: this.attachmentMode,
                        },
                        "Processing message with history",
                    );

                    // Generate the AI response; the orchestrator handles Gemini file refresh internally
                    // per key attempt, threaded via attachmentFetcher in context.
                    const { content, newMessages, isRetryable, usedFallback } = await this.orchestrator.process(
                        history,
                        params.intent,
                        params.onStatusUpdate,
                    );

                    if (!content) {
                        this.logger.warn(
                            { discordMessageId: params.discordMessageId },
                            "Orchestrator returned empty content",
                        );
                        return {
                            response: "Sorry, I encountered an error processing your request.",
                            newMessages,
                            isFailure: true,
                            isRetryable: true,
                        };
                    }

                    return {
                        response: content,
                        newMessages,
                        isRetryable: isRetryable || undefined,
                        usedFallback: usedFallback || undefined,
                    };
                },
            );
        } catch (err) {
            this.logger.error({ err, discordMessageId: params.discordMessageId }, "Failed to process message");
            Sentry.captureException(err);
            const displayMessage = extractDisplayMessage(err);
            return {
                response: displayMessage ?? "Sorry, I encountered an error processing your request.",
                newMessages: [],
                isFailure: true,
                isRetryable: true,
            };
        }
    }

    /**
     * Fetches the live Discord reply chain starting from the given message ID,
     * persists any messages not already in the DB (with full Gemini upload treatment),
     * then re-fetches the chain from the DB for use as conversation history.
     *
     * Throws on Discord API or DB failures — the caller's outer try/catch returns a
     * retryable error response to the user.
     */
    private async fetchAndPersistLiveChain(
        chatMessageService: IChatMessageService,
        referencedMessageId: string,
        channelId: string,
        guildId: string,
        onStatusUpdate?: OnStatusUpdate,
        limit?: number,
    ): Promise<DiscordMessage[]> {
        return Sentry.startSpan(
            {
                name: "Fetch and persist live chain",
                op: "app.message.live_chain_fetch",
                attributes: { "discord.message_id": referencedMessageId },
            },
            async (span) => {
                const snapshots = await chatMessageService.fetchChain({
                    startDiscordMessageId: referencedMessageId,
                    channelId,
                    guildId,
                });

                span.setAttribute("app.live_chain_length", snapshots.length);

                if (snapshots.length === 0) {
                    this.logger.debug(
                        { referencedMessageId },
                        "Live chain fetch returned no messages — proceeding without history",
                    );
                    return [];
                }

                // Determine which snapshots are already in the DB to avoid re-inserting them
                const existingIds = await this.messageRepo.findExistingDiscordIds({
                    guildId,
                    channelId,
                    discordMessageIds: snapshots.map((s) => s.id),
                });
                const existingIdSet = new Set(existingIds);

                // Only build and persist messages that are not yet in the DB
                const newSnapshots = snapshots.filter((s) => !existingIdSet.has(s.id));

                span.setAttribute("app.live_chain_new_messages", newSnapshots.length);

                if (newSnapshots.length > 0) {
                    // Build a LangChain message and collect pending Gemini records for each new snapshot
                    const built: Array<{
                        snapshot: DiscordMessageSnapshot;
                        msg: BaseMessage;
                        pendingRecords: PendingGeminiRecord[];
                    }> = [];

                    for (const snapshot of newSnapshots) {
                        const content = snapshot.isOwnBot ? snapshot.content : discordMessageToLlmText(snapshot);

                        const { msg, pendingRecords } = await this.buildMessage({
                            role: snapshot.isOwnBot ? "assistant" : "human",
                            content,
                            attachments: snapshot.attachments,
                            onStatusUpdate,
                        });

                        built.push({ snapshot, msg, pendingRecords });
                    }

                    // Batch-insert all new message rows. saveBatch returns exactly N rows
                    // (one per input) in insertion order — pre-existing rows are included
                    // via the no-op conflict update, so index correlation is safe.
                    const savedRows = await this.messageRepo.saveBatch(
                        built.map(({ snapshot, msg }) => ({
                            discordMessageId: snapshot.id,
                            repliesToDiscordId: snapshot.referencedMessageId,
                            channelId: snapshot.channelId,
                            guildId: snapshot.guildId,
                            role: snapshot.isOwnBot ? "assistant" : ("human" as const),
                            discordAuthorId: snapshot.authorId,
                            // TYPE COERCION: BaseMessage.toJSON() returns LangChain's internal Serialized type,
                            // which is incompatible with our DB schema's Record<string, unknown>. Double cast
                            // through unknown bridges the gap — the serialized shape IS a plain JSON object.
                            langchainMessages: [msg.toJSON() as unknown as Record<string, unknown>],
                            retriesLeft: null,
                            usedFallback: null,
                            interactionType: null,
                            interactionAuthorDiscordId: null,
                        })),
                    );

                    // Two-phase Gemini save for each snapshot that had uploads.
                    // savedRows is index-aligned with built (N in, N out).
                    for (let i = 0; i < built.length; i++) {
                        // biome-ignore lint/style/noNonNullAssertion: index always in-bounds (same-length arrays)
                        const { pendingRecords } = built[i]!;
                        if (pendingRecords.length === 0) continue;
                        // biome-ignore lint/style/noNonNullAssertion: index always in-bounds (same-length arrays)
                        await this.persistPendingGeminiRecords(pendingRecords, savedRows[i]!.id);
                    }
                }

                // Re-fetch from DB now that all messages are persisted — reuses the
                // established orchestrator.buildHistory() deserialization path.
                return this.messageRepo.fetchChain({
                    startDiscordMessageId: referencedMessageId,
                    channelId,
                    guildId,
                    limit,
                });
            },
        );
    }

    /**
     * Runs the two-phase Gemini file save for each pending record collected during
     * {@link buildMessage} in upload mode.
     *
     * Phase 1: `saveFiles` — idempotent batch insert into `gemini_files` (permanent anchors).
     * Phase 2: `upsertUploads` — batch insert/update `gemini_file_uploads` (ephemeral per-key records).
     *
     * No-ops when `pendingRecords` is empty or when Gemini deps are not injected.
     */
    private async persistPendingGeminiRecords(pendingRecords: PendingGeminiRecord[], messageId: string): Promise<void> {
        if (pendingRecords.length === 0) return;

        if (!this.geminiFileRepo || !this.geminiFileUploader) {
            throw new Error("Upload mode repository dependencies not injected into HandleDiscordMessage");
        }

        const { geminiFileRepo, geminiFileUploader } = this;

        // Phase 1: batch-insert all file anchors.
        // ON CONFLICT DO UPDATE (no-op) ensures pre-existing rows are returned too,
        // so we always have the UUIDs needed for the upload FK.
        const savedFiles = await geminiFileRepo.saveFiles(
            pendingRecords.map(({ fileAnchor }) => ({ ...fileAnchor, messageId })),
        );

        // Phase 2: batch-upsert all upload records using the UUIDs from phase 1.
        // savedFiles is in insertion order, matching pendingRecords index-for-index.
        await geminiFileRepo.upsertUploads(
            savedFiles.map((savedFile, i) => ({
                // Non-null assertion safe: savedFiles.length === pendingRecords.length (same batch)
                geminiFileId: savedFile.id,
                apiKeyId: geminiFileUploader.apiKeyId,
                // biome-ignore lint/style/noNonNullAssertion: index is always in-bounds (same-length arrays)
                ...pendingRecords[i]!.uploadData,
            })),
        );
    }

    /**
     * Constructs a LangChain message from content and optional file attachments.
     * Produces a {@link HumanMessage} for role "human" and an {@link AIMessage} for role "assistant".
     * The message class is the only difference — attachment handling and content parts are identical.
     *
     * Delegates to the appropriate builder based on the configured attachment mode.
     * If there are no attachments, always returns a simple string-content message.
     *
     * In upload mode, also returns `pendingRecords` — split GeminiFile + upload data
     * that must be saved to the DB **after** the message row exists (FK constraint).
     * In all other modes `pendingRecords` is always an empty array.
     *
     * @param params.role - "human" for user messages, "assistant" for bot messages
     * @param params.content - Formatted message text (already enriched with attribution if needed)
     * @param params.attachments - File attachments to embed or upload
     * @param params.onStatusUpdate - Optional status callback for the downloading status update
     */
    private async buildMessage<R extends "human" | "assistant">(params: {
        role: R;
        content: string;
        attachments: DiscordAttachmentInfo[];
        onStatusUpdate?: OnStatusUpdate;
    }): Promise<{
        msg: R extends "human" ? HumanMessage : AIMessage;
        pendingRecords: PendingGeminiRecord[];
    }> {
        const { role, content, attachments, onStatusUpdate } = params;

        // TYPE COERCION: TypeScript cannot narrow a conditional return type (R extends "human" ? ...)
        // from within the generic implementation body — the union HumanMessage | AIMessage is not
        // assignable to the unresolved conditional type even though it is always correct at runtime.
        const wrap = (contentParts: HumanMessage["content"]) =>
            (role === "human"
                ? new HumanMessage({ content: contentParts })
                : new AIMessage({ content: contentParts })) as R extends "human" ? HumanMessage : AIMessage;

        if (attachments.length === 0) {
            return { msg: wrap(content), pendingRecords: [] };
        }

        onStatusUpdate?.({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS });

        if (this.attachmentMode === AttachmentMode.upload) {
            const { contentParts, pendingRecords } = await this.buildUploadModeContentParts(content, attachments);
            return { msg: wrap(contentParts), pendingRecords };
        }

        const contentParts = await this.buildInlineModeContentParts(content, attachments);
        return { msg: wrap(contentParts), pendingRecords: [] };
    }

    /**
     * Inline mode: downloads each attachment to memory as base64, embeds directly in message content parts.
     */
    private async buildInlineModeContentParts(
        content: string,
        attachments: DiscordAttachmentInfo[],
    ): Promise<Array<{ type: "text"; text: string } | { type: "media"; mimeType: string; data: string }>> {
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
     * Upload mode: streams each attachment to a temp file, uploads to Gemini Files API,
     * then returns content parts with Gemini URL references and pending Gemini records.
     *
     * Temp files are deleted in a try/finally after each upload.
     * Gemini file records are NOT saved here — they are returned as `pendingRecords`
     * so that the caller can persist them after the message row exists and its
     * UUID primary key is available (required to satisfy the `gemini_files.message_id` FK).
     */
    private async buildUploadModeContentParts(
        content: string,
        attachments: DiscordAttachmentInfo[],
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
                if (!this.diskDownloader || !this.geminiFileUploader) {
                    throw new Error("Upload mode dependencies not injected into HandleDiscordMessage");
                }

                // Legacy LangChain media format for file references — uses fileUri instead of data.
                // See buildInlineModeContentParts comment above for why we use type: "media".
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

                        // Collect the split record; saved by caller after the message row exists.
                        // originalGeminiUrl = geminiUrl on first upload — this is the immutable lookup key
                        // stored in LangChain content blocks and used by GeminiFileRefreshService.
                        pendingRecords.push({
                            fileAnchor: {
                                originalGeminiUrl: uploaded.geminiUrl,
                                discordAttachmentId: attachment.id,
                                discordFilename: attachment.name,
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

                return {
                    contentParts: [...(content ? [{ type: "text" as const, text: content }] : []), ...uploadedParts],
                    pendingRecords,
                };
            },
        );
    }
}
