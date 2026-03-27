import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import { extractDisplayMessage } from "../../domain/errors/AppError.ts";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import type { MessageInteractionType, PersistedChatMessage } from "../../domain/message/Message.ts";
import { MessageIntent } from "../../domain/message/MessageIntent.ts";
import type { IMessagePageRepository } from "../../domain/message/MessagePage.ts";
import { shortenRedirectUrl } from "../../infrastructure/http/redirectUrl.ts";
import { SearchMode } from "../config/AppConfig.ts";
import { agentStatusLabel } from "../formatters/agentStatus.ts";
import { extractWebGroundingChunks, formatGroundingSources } from "../formatters/groundingSources.ts";
import { splitMarkdown } from "../formatters/markdownSplitter.ts";
import { discordMessageToLlmText, llmTextToDiscordText } from "../formatters/textTransformers.ts";
import { buildLangchainMessage } from "../helpers/buildLangchainMessage.ts";
import { extractUserContent } from "../helpers/extractUserContent.ts";
import { hasExtendedMarkdown } from "../helpers/hasExtendedMarkdown.ts";
import { parseMessageIntent } from "../helpers/parseMessageIntent.ts";
import type {
    IChatClientBot,
    IChatClientMessage,
    IChatClientMessageAttachment,
    IChatClientMessageButton,
    IChatClientMessageEmbed,
} from "../ports/chat/IChatClient.ts";
import type { IAgentOrchestrator } from "../ports/IAgentOrchestrator.ts";
import type { IChatMessageService } from "../ports/IChatMessageService.ts";
import type { IInlineMediaNormalizer } from "../ports/IInlineMediaNormalizer.ts";
import type { StatusMessageUpdater } from "../services/StatusMessageUpdater.ts";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";
import type { Logger } from "../types/Logger.ts";

/** Sentinel used for DM guildId. */
const DM_GUILD_TOKEN = "@me";

/** Discord's maximum message length in characters. */
const MESSAGE_LENGTH_LIMIT = 2000;

/** Custom ID for the Retry button attached to failed bot responses. */
const RETRY_BUTTON_ID = "retry_mention";

/** Custom ID for the Next Page button attached to paginated bot responses. */
const NEXT_PAGE_BUTTON_ID = "next_page";

/** Custom ID for the Render button attached to responses containing extended markdown. */
const RENDER_BUTTON_ID = "render_image";

/**
 * Internal agent result produced by {@link HandleChatMessageUseCase.invokeAgent}
 * and consumed immediately by {@link HandleChatMessageUseCase.sendAgentResponse}.
 * `thinkingMessagePromise` is always defined — the thinking placeholder is always sent.
 */
type AgentResult = {
    response: string;
    newMessages: BaseMessage[];
    isFailure?: boolean;
    isRetryable?: boolean;
    usedFallback?: boolean;
    thinkingMessagePromise: Promise<IChatClientMessage>;
};

/**
 * Application use case: process an incoming chat message from end to end.
 *
 * Owns the full pipeline:
 * - Intent parsing and guard checks (bot author, shutdown, rate limit, empty content)
 * - Thinking placeholder lifecycle (fire-and-forget send, status update wiring, error edit)
 * - Attachment download/upload and LangChain message construction
 * - Reply chain history fetch (DB, with live Discord fallback)
 * - LLM orchestration via {@link IAgentOrchestrator}
 * - Delivering the bot reply: text transform, pagination, button attachment, DB persistence
 */
export class HandleChatMessageUseCase {
    constructor(
        private readonly orchestrator: IAgentOrchestrator,
        private readonly messageRepo: IMessageRepository,
        private readonly statusUpdater: StatusMessageUpdater,
        private readonly logger: Logger,
        private readonly bot: IChatClientBot,
        private readonly previousBotId: string | undefined,
        private readonly messagePageRepo: IMessagePageRepository,
        private readonly retries: number,
        private readonly searchMode: SearchMode,
        private readonly chatMessageService?: IChatMessageService,
        private readonly enableInDMs: boolean = false,
        /** Required in inline attachment mode: resolves discord:// token URLs to base64 data blocks. */
        private readonly inlineMediaNormalizer?: IInlineMediaNormalizer,
        /** Maximum total attachment bytes allowed per message in inline mode. Null = no limit. */
        private readonly maxInlineAttachmentBytes: number | null = null,
    ) {}

    /**
     * Execute the full message-handling pipeline for a single incoming chat message,
     * wrapped in a Sentry span. Runs guards, builds agent input, invokes the agent,
     * and delivers the bot reply. Returns early (having already replied) for bot
     * authors, unknown intent without a mention, shutdown, or rate limit.
     */
    async execute(params: {
        message: IChatClientMessage;
        shutdownPending: boolean;
        isRateLimited: boolean;
        /** Retries remaining for this response. Undefined on a fresh message. */
        retriesLeft?: number | null;
        interactionType?: MessageInteractionType;
    }): Promise<void> {
        const { message, shutdownPending, isRateLimited, retriesLeft, interactionType } = params;

        // Ignore all bot messages (including our own) to prevent feedback loops
        if (message.isAuthorBot) return;

        // Silently ignore DM messages when DM support is disabled
        if (message.isDM && !this.enableInDMs) return;

        // Parse intent from raw content before stripping, so the command prefix is visible
        const intent = parseMessageIntent(message.content);

        // Only respond to explicit @mentions or recognized command prefixes
        if (intent === MessageIntent.UNKNOWN && !message.hasExplicitMention(this.bot.userId)) return;

        await Sentry.startSpan(
            {
                name: "Handle chat message",
                op: "chat.message.handle",
                attributes: {
                    // NOTE: pass in to use case when extending
                    "chat.platform": "Discord",
                    "chat.message_id": message.id,
                    "chat.channel_id": message.channelId,
                    "chat.guild_id": message.guildId ?? DM_GUILD_TOKEN,
                    "chat.attachment_count": message.attachments.length,
                    "chat.has_reply": message.referencedMessageId !== null,
                },
            },
            async (span) => {
                if (shutdownPending) {
                    const reply = await message.reply({ content: "*A restart is pending, try again later.*" });
                    await this.messageRepo.saveBotPlaceholderMessage({
                        discordMessageId: reply.id,
                        repliesToDiscordId: message.id,
                        channelId: reply.channelId,
                        guildId: reply.guildId ?? DM_GUILD_TOKEN,
                        discordAuthorId: this.bot.userId,
                    });
                    return;
                }

                if (isRateLimited) {
                    const rateLimitReply = await message.reply({
                        content:
                            "Hi! It seems you have sent too many messages at once recently. Please wait a while before sending more.",
                    });
                    await this.messageRepo.saveBotPlaceholderMessage({
                        discordMessageId: rateLimitReply.id,
                        repliesToDiscordId: message.id,
                        channelId: rateLimitReply.channelId,
                        guildId: rateLimitReply.guildId ?? DM_GUILD_TOKEN,
                        discordAuthorId: this.bot.userId,
                    });
                    return;
                }

                const userContent = extractUserContent(message.content, this.bot.userId, message.botRoleId);
                const attachments = message.attachments;

                // No usable content after stripping mentions/commands, no attachments, and no reply
                // reference — substitute a synthetic greeting so the agent can introduce itself.
                // When the message is a reply, context comes from the reply chain; skip the greeting.
                const effectiveUserContent =
                    !userContent && attachments.length === 0 && message.referencedMessageId === null
                        ? "Hi, can you introduce yourself?"
                        : userContent;

                this.logger.info(
                    {
                        discordMessageId: message.id,
                        channelId: message.channelId,
                        referencedMessageId: message.referencedMessageId,
                        attachmentCount: attachments.length,
                    },
                    "Processing bot message",
                );

                const result = await this.invokeAgent({
                    message,
                    userContent: effectiveUserContent,
                    attachments,
                    intent,
                });
                await this.sendAgentResponse({
                    replyTarget: message,
                    ...result,
                    retriesLeft,
                    interactionType,
                    span,
                });
            },
        );
    }

    /**
     * Core agent invocation: sends the thinking placeholder, fetches history,
     * builds the human message, runs orchestration, and returns the agent result.
     * On error, edits the thinking placeholder with an error notice and persists it.
     * Never throws — returns a settled failure result.
     */
    async invokeAgent(params: {
        /** The chat message to reply to. */
        message: IChatClientMessage;
        userContent: string | null;
        attachments: IChatClientMessageAttachment[] | null;
        embeds?: IChatClientMessageEmbed[];
        intent: MessageIntent;
        /** Label shown in the thinking placeholder. Defaults to "Thinking". */
        thinkingText?: string;
        reuseHumanMessage?: boolean;
        fetchHistory?: boolean;
        ephemeralInstructionMessage?: string;
    }): Promise<AgentResult> {
        const {
            message,
            userContent,
            attachments,
            embeds,
            intent,
            thinkingText = "Thinking",
            reuseHumanMessage,
            fetchHistory,
            ephemeralInstructionMessage,
        } = params;

        // Send the "Thinking" placeholder immediately — fire-and-forget (not awaited)
        // so it does not delay AI processing. Sent as a reply with allowedMentions
        // suppressed so the user is not pinged at this stage. The promise is resolved
        // lazily on the first status update, or awaited when we need to delete it
        // after the real response is sent.
        let thinkingMessagePromise: Promise<IChatClientMessage> = message.reply({
            content: `*${thinkingText} since <t:${Math.round(Date.now() / 1000)}:R>*`,
            allowedMentions: { repliedUser: false },
        });

        try {
            const onStatusUpdate = (update: Parameters<typeof agentStatusLabel>[0]) => {
                // Await the thinking message promise so we have the message ID before
                // scheduling an edit. The promise resolves on the first call and is
                // replaced with a pre-resolved promise for all subsequent status updates.
                // thinkingMessagePromise is always assigned before onStatusUpdate
                // can be called — the assignment is on the line above this closure.
                thinkingMessagePromise = thinkingMessagePromise.then((thinkingMessage) => {
                    this.statusUpdater.scheduleUpdate(
                        message.channelId,
                        thinkingMessage.id,
                        async (content: string) =>
                            void (await thinkingMessage.edit({
                                content: `*${content} since <t:${Math.round(Date.now() / 1000)}:R>*`,
                            })),
                        agentStatusLabel(update),
                    );
                    return thinkingMessage;
                });
            };

            const { response, newMessages, isFailure, isRetryable, usedFallback } = await this.processMessage({
                discordMessageId: message.id,
                referencedMessageId: message.referencedMessageId,
                channelId: message.channelId,
                guildId: message.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: message.authorId,
                message: userContent !== null ? message : null,
                strippedContent: userContent,
                attachments: attachments ?? [],
                embeds: embeds ?? message.embeds,
                intent,
                onStatusUpdate,
                reuseHumanMessage,
                fetchHistory,
                ephemeralInstructionMessage,
            });

            return {
                response,
                newMessages,
                isFailure,
                isRetryable,
                usedFallback,
                // TYPE COERCION: thinkingMessagePromise is always assigned before any await
                // that could skip the assignment — the undefined case is structurally impossible.
                thinkingMessagePromise,
            };
        } catch (err) {
            this.logger.error({ err, discordMessageId: message.id }, "Failed to invoke agent");
            Sentry.captureException(err);

            // Attempt to edit the thinking message with an error notice. Guard
            // against the error having been thrown before the thinking message
            // send was initiated. It may also already be deleted if the error
            // occurred after thinkingMessage.delete(), so swallow any failure.
            thinkingMessagePromise
                .then(async (thinkingMessage) => {
                    this.statusUpdater.cancel(thinkingMessage.id);
                    const errorReply = await thinkingMessage.edit({
                        content: "Sorry, I encountered an error processing your request.",
                    });
                    // Persist the error message so it participates in the reply chain.
                    await this.messageRepo.saveBotPlaceholderMessage({
                        discordMessageId: errorReply.id,
                        repliesToDiscordId: message.id,
                        channelId: errorReply.channelId,
                        guildId: errorReply.guildId ?? DM_GUILD_TOKEN,
                        discordAuthorId: this.bot.userId,
                    });
                })
                .catch((editErr) => {
                    this.logger.warn(
                        { editErr, discordMessageId: message.id },
                        "Failed to edit thinking message with error notice",
                    );
                });

            return {
                response: "",
                newMessages: [],
                isFailure: true,
                isRetryable: false,
                usedFallback: false,
                thinkingMessagePromise,
            };
        }
    }

    /**
     * Invokes the agent then immediately delivers the bot reply.
     * Used by retry and summarize handlers that need fine-grained control over
     * reply options (pingUser, replyPrefix, retriesLeft, etc.).
     */
    async invokeAgentAndReply(params: {
        message: IChatClientMessage;
        userContent: string | null;
        attachments: IChatClientMessageAttachment[] | null;
        embeds?: IChatClientMessageEmbed[];
        intent: MessageIntent;
        thinkingText?: string;
        reuseHumanMessage?: boolean;
        fetchHistory?: boolean;
        ephemeralInstructionMessage?: string;
        retriesLeft?: number | null;
        pingUser?: boolean;
        replyPrefix?: string;
        interactionType?: MessageInteractionType;
        interactionAuthorDiscordId?: string;
        span: Sentry.Span;
    }): Promise<void> {
        const {
            retriesLeft,
            pingUser,
            replyPrefix,
            interactionType,
            interactionAuthorDiscordId,
            span,
            ...agentParams
        } = params;
        const result = await this.invokeAgent(agentParams);
        await this.sendAgentResponse({
            replyTarget: params.message,
            ...result,
            retriesLeft,
            pingUser,
            replyPrefix,
            interactionType,
            interactionAuthorDiscordId,
            span,
        });
    }

    /**
     * Core message-processing pipeline: history fetch, human message construction,
     * orchestrator invocation, and human message persistence.
     *
     * Mirrors the former HandleDiscordMessageUseCase.execute() — inlined here so the
     * full pipeline lives in one use case without an intermediate delegation layer.
     */
    private async processMessage(params: {
        discordMessageId: string;
        referencedMessageId: string | null;
        channelId: string;
        guildId: string;
        discordAuthorId: string;
        /** The live message object. Null when reuseHumanMessage is true. */
        message: IChatClientMessage | null;
        /** Content with bot mentions and command prefix already stripped. Null when reuseHumanMessage is true. */
        strippedContent: string | null;
        attachments: IChatClientMessageAttachment[];
        embeds?: IChatClientMessageEmbed[];
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
                    name: "Process chat message",
                    op: "app.message.process",
                    attributes: {
                        "chat.message_id": params.discordMessageId,
                        "app.attachment_count": params.attachments.length,
                        "app.has_reply_chain": params.referencedMessageId !== null,
                    },
                },
                async (span) => {
                    if (this.maxInlineAttachmentBytes !== null && params.attachments.length > 0) {
                        const totalBytes = params.attachments.reduce((sum, a) => sum + a.size, 0);
                        if (totalBytes > this.maxInlineAttachmentBytes) {
                            const limitMb = this.maxInlineAttachmentBytes / (1024 * 1024);
                            const actualMb = (totalBytes / (1024 * 1024)).toFixed(1);
                            this.logger.warn(
                                {
                                    totalBytes,
                                    maxBytes: this.maxInlineAttachmentBytes,
                                    discordMessageId: params.discordMessageId,
                                },
                                "Attachment size exceeds inline limit — rejecting",
                            );
                            return {
                                response: `Sorry, your attachments total ${actualMb} MB which exceeds the ${limitMb} MB limit. Please send smaller files.`,
                                newMessages: [],
                            };
                        }
                    }

                    let dbHistory: PersistedChatMessage[];
                    let thisTurnMessage: HumanMessage | undefined;

                    if (params.reuseHumanMessage) {
                        // The human message row already exists in the DB — fetch the full chain
                        // starting from discordMessageId itself (includes history + human message).
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
                        if (dbHistory.length === 0 && params.referencedMessageId !== null && this.chatMessageService) {
                            dbHistory = await this.fetchAndPersistLiveChain(
                                this.chatMessageService,
                                params.referencedMessageId,
                                params.channelId,
                                params.guildId,
                                params.fetchHistory === false ? 1 : undefined,
                            );
                        }

                        const builtMsg = await buildLangchainMessage({
                            role: "human",
                            content:
                                params.message !== null
                                    ? discordMessageToLlmText(params.message, params.strippedContent ?? undefined)
                                    : "",
                            attachments: params.attachments,
                            embeds: params.embeds,
                            logger: this.logger,
                            guildId: params.guildId,
                            channelId: params.channelId,
                            discordMessageId: params.discordMessageId,
                        });

                        // Persist the user's message (token URL blocks — no uploads at this stage)
                        await this.messageRepo.save({
                            discordMessageId: params.discordMessageId,
                            repliesToDiscordId: params.referencedMessageId,
                            channelId: params.channelId,
                            guildId: params.guildId,
                            role: "human",
                            discordAuthorId: params.discordAuthorId,
                            langchainMessages: [builtMsg],
                            retriesLeft: null,
                            usedFallback: null,
                            interactionType: null,
                            interactionAuthorDiscordId: null,
                        });

                        thisTurnMessage = builtMsg;
                    }

                    const history = this.orchestrator.buildHistory(dbHistory);
                    if (thisTurnMessage) history.push(thisTurnMessage);

                    // If the oldest message in history is not a HumanMessage, Gemini will reject it
                    // (conversations must start with a human turn). Insert a placeholder rather than
                    // converting the existing message — converting an AIMessage with tool calls would
                    // corrupt the tool call chain and cause ToolCallNotFoundError.
                    if (history.length > 0 && !(history[0] instanceof HumanMessage)) {
                        history.unshift(new HumanMessage("<History omitted>"));
                    }

                    // Append an ephemeral instruction as the final user turn when provided.
                    // The target message content stays in history as context; never persisted.
                    if (params.ephemeralInstructionMessage)
                        history.push(new HumanMessage(params.ephemeralInstructionMessage));

                    // Guard: the last message must be a HumanMessage for the orchestrator.
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

                    // In inline mode, media blocks in history contain discord:// token URLs
                    // instead of raw base64. Resolve them to data blocks before sending to the LLM.
                    const llmHistory = this.inlineMediaNormalizer
                        ? await this.inlineMediaNormalizer.normalize(history, params.onStatusUpdate)
                        : history;

                    this.logger.debug(
                        {
                            discordMessageId: params.discordMessageId,
                            historyLength: history.length,
                            hasReply: params.referencedMessageId !== null,
                            attachmentCount: params.attachments.length,
                        },
                        "Processing message with history",
                    );

                    const { content, newMessages, isRetryable, usedFallback } = await this.orchestrator.process(
                        llmHistory,
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
     * Delivers the agent result to the user: cancels/deletes the thinking placeholder,
     * transforms the LLM text, handles pagination, attaches buttons, and persists the
     * bot reply row. Shared by {@link execute} and {@link invokeAgentAndReply}.
     */
    private async sendAgentResponse(params: {
        replyTarget: IChatClientMessage;
        response: string;
        newMessages: BaseMessage[];
        isFailure?: boolean;
        isRetryable?: boolean;
        usedFallback?: boolean;
        retriesLeft?: number | null;
        thinkingMessagePromise: Promise<IChatClientMessage>;
        span: Sentry.Span;
        pingUser?: boolean;
        replyPrefix?: string;
        interactionType?: MessageInteractionType;
        interactionAuthorDiscordId?: string;
    }): Promise<void> {
        const {
            replyTarget,
            response,
            newMessages,
            isFailure,
            isRetryable,
            usedFallback,
            retriesLeft,
            thinkingMessagePromise,
            span,
            pingUser = true,
            replyPrefix,
            interactionType,
            interactionAuthorDiscordId,
        } = params;

        // Cancel any pending status edit and delete the thinking placeholder before sending
        // the real response so the user is pinged on the final message, not the placeholder.
        thinkingMessagePromise
            .then((thinkingMessage) => {
                this.statusUpdater.cancel(thinkingMessage.id);
                thinkingMessage.delete();
            })
            .catch((err) => {
                this.logger.warn({ err }, "Failed to delete thinking message");
            });

        // Sanitize LLM output for Discord rendering
        const discordResponse = llmTextToDiscordText(response);

        // Informational footer appended to the first page when a fallback model was used.
        // Kept separate from discordResponse so pagination offsets stored in the DB always
        // refer to positions within discordResponse — subsequent pages are served from that
        // string and must not be offset by the footer length.
        const fallbackFooter = usedFallback
            ? "\n*This response was generated using a fallback model. If it's unsatisfactory you can try to Retry later to see if the primary model is available again.*"
            : "";

        // Start resolving grounding sources in parallel with sending the response and saving to DB.
        // Skipped on failure responses — the error message has no meaningful sources to cite,
        // and in Tavily mode the triage AIMessage may carry tool calls that would produce
        // spurious source citations even though no real LLM answer was generated.
        const sourcesLinePromise = isFailure ? Promise.resolve(null) : this.resolveGroundingSources(newMessages);

        // Attach a Retry button when the use case signals a retryable failure and retries remain.
        // retriesLeft=undefined means this is a fresh response — use configured retries.
        // retriesLeft=0 means all retries exhausted — suppress the button.
        const effectiveRetriesLeft = retriesLeft ?? this.retries;
        const retryButton: IChatClientMessageButton | undefined =
            isRetryable && effectiveRetriesLeft > 0
                ? {
                      customId: RETRY_BUTTON_ID,
                      label: `Retry · ${effectiveRetriesLeft} ${effectiveRetriesLeft === 1 ? "Retry" : "Retries"} Left`,
                      style: isFailure ? "primary" : "secondary",
                  }
                : undefined;

        // Attach a Render button when the full response contains extended markdown features
        // (LaTeX equations or tables) that benefit from rich rendering.
        const renderButton: IChatClientMessageButton | undefined = hasExtendedMarkdown(response)
            ? { customId: RENDER_BUTTON_ID, label: "Render", style: "secondary" }
            : undefined;

        // Space reserved on the first page for replyPrefix (+ trailing space) and fallbackFooter.
        const page1Overhead = (replyPrefix ? replyPrefix.length + 1 : 0) + fallbackFooter.length;

        if (discordResponse.length + page1Overhead > MESSAGE_LENGTH_LIMIT) {
            // --- PAGINATED PATH ---
            const {
                content: page1Content,
                newOffset,
                pageCount: totalPages,
                endedInCodeBlock: page1EndedInCodeBlock,
                codeBlockType: page1CodeBlockType,
            } = splitMarkdown(discordResponse, 0, MESSAGE_LENGTH_LIMIT, {
                pageCount: true,
                firstPageLimit: MESSAGE_LENGTH_LIMIT - page1Overhead,
            });

            if (!totalPages) {
                throw new Error("splitMarkdown did not return pageCount for paginated content");
            }

            const firstPageButtons: IChatClientMessageButton[] = [
                { customId: NEXT_PAGE_BUTTON_ID, label: `Next Page · Page 1 of ${totalPages}`, style: "primary" },
                ...(retryButton ? [retryButton] : []),
                ...(renderButton ? [renderButton] : []),
            ];

            const botReply = await replyTarget.reply({
                content: (replyPrefix ? `${replyPrefix} ` : "") + page1Content + fallbackFooter,
                buttons: firstPageButtons,
                ...(!pingUser && {
                    allowedMentions: {
                        repliedUser: false,
                        ...(interactionAuthorDiscordId && { users: [interactionAuthorDiscordId] }),
                    },
                }),
            });

            span.setAttributes({
                "chat.response.paginated": true,
                "chat.response.total_pages": totalPages,
            });

            // messages row must exist before messagePageRepo.save (FK constraint)
            const savedBotMsg = await this.messageRepo.saveBotMessage({
                discordMessageId: botReply.id,
                repliesToDiscordId: replyTarget.id,
                channelId: botReply.channelId,
                guildId: botReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.bot.userId,
                langchainMessages: newMessages,
                retriesLeft: isRetryable ? effectiveRetriesLeft : null,
                usedFallback: usedFallback ?? false,
                interactionType: interactionType ?? null,
                interactionAuthorDiscordId: interactionAuthorDiscordId ?? null,
            });
            await this.messagePageRepo.save({
                messageId: savedBotMsg.id,
                firstPageMessageId: savedBotMsg.id,
                endOffset: newOffset,
                currentPage: 1,
                totalPages,
                endedInCodeBlock: page1EndedInCodeBlock,
                codeBlockType: page1CodeBlockType,
            });

            const sourcesLine = await sourcesLinePromise;
            if (sourcesLine) {
                await this.sendSourcesReply(botReply, sourcesLine);
            }
        } else {
            // --- NON-PAGINATED PATH ---

            const sourcesLine = await sourcesLinePromise;
            const responseWithFooter = discordResponse + fallbackFooter;
            const combined =
                sourcesLine && responseWithFooter.length + 1 + sourcesLine.length <= MESSAGE_LENGTH_LIMIT
                    ? `${responseWithFooter}\n${sourcesLine}`
                    : null;

            const nonPaginatedButtons: IChatClientMessageButton[] = [
                ...(retryButton ? [retryButton] : []),
                ...(renderButton ? [renderButton] : []),
            ];

            const botReply = await replyTarget.reply({
                content: (replyPrefix ? `${replyPrefix} ` : "") + (combined ?? responseWithFooter),
                ...(nonPaginatedButtons.length > 0 && { buttons: nonPaginatedButtons }),
                ...(!pingUser && {
                    allowedMentions: {
                        repliedUser: false,
                        ...(interactionAuthorDiscordId && { users: [interactionAuthorDiscordId] }),
                    },
                }),
            });

            span.setAttributes({ "chat.paginated": false });

            await this.messageRepo.saveBotMessage({
                discordMessageId: botReply.id,
                repliesToDiscordId: replyTarget.id,
                channelId: botReply.channelId,
                guildId: botReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.bot.userId,
                langchainMessages: newMessages,
                retriesLeft: isRetryable ? effectiveRetriesLeft : null,
                usedFallback: usedFallback ?? false,
                interactionType: interactionType ?? null,
                interactionAuthorDiscordId: interactionAuthorDiscordId ?? null,
            });

            if (sourcesLine && !combined) {
                await this.sendSourcesReply(botReply, sourcesLine);
            }
        }

        span.setAttributes({
            "chat.response_length": response.length,
            "chat.is_failure": isFailure ?? false,
        });
    }

    /** Sends grounding source citations as a follow-up reply and persists the row. */
    private async sendSourcesReply(replyTo: IChatClientMessage, sourcesLine: string): Promise<void> {
        try {
            const sourcesReply = await replyTo.reply({ content: sourcesLine });
            await this.messageRepo.saveBotPlaceholderMessage({
                discordMessageId: sourcesReply.id,
                repliesToDiscordId: replyTo.id,
                channelId: sourcesReply.channelId,
                guildId: sourcesReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.bot.userId,
            });
        } catch (err) {
            this.logger.warn({ err }, "Failed to send grounding sources reply");
        }
    }

    /**
     * Extracts grounding source chunks from the last AIMessage in `newMessages` and
     * formats them as a Discord sources line. Returns null when no grounding data is present.
     */
    private async resolveGroundingSources(newMessages: BaseMessage[]): Promise<string | null> {
        const lastMessage = newMessages.at(-1);
        if (!(lastMessage instanceof AIMessage)) return null;

        const rawChunks = extractWebGroundingChunks(lastMessage.additional_kwargs);
        if (rawChunks.length === 0) return null;

        const GOOGLE_REDIRECT_PREFIX = "https://vertexaisearch.cloud.google.com";

        const sources = await Promise.all(
            rawChunks.map(async ({ uri, title }) => {
                if (this.searchMode === SearchMode.google) {
                    if (!uri.startsWith(GOOGLE_REDIRECT_PREFIX)) {
                        this.logger.error(
                            { uri },
                            "Google Search grounding URI does not match expected redirect prefix — may need updating",
                        );
                        return { title, url: uri };
                    }
                    return { title, url: await shortenRedirectUrl(uri) };
                }
                return { title, url: uri };
            }),
        );

        return formatGroundingSources(sources);
    }

    /**
     * Fetches the live Discord reply chain starting from the given message ID,
     * persists any messages not already in the DB (with full Gemini upload treatment),
     * then re-fetches the chain from the DB for use as conversation history.
     */
    private async fetchAndPersistLiveChain(
        chatMessageService: IChatMessageService,
        referencedMessageId: string,
        channelId: string,
        guildId: string,
        limit?: number,
    ): Promise<PersistedChatMessage[]> {
        return Sentry.startSpan(
            {
                name: "Fetch and persist live chain",
                op: "app.message.live_chain_fetch",
                attributes: { "chat.message_id": referencedMessageId },
            },
            async (span) => {
                const messages = await chatMessageService.fetchChain({
                    startDiscordMessageId: referencedMessageId,
                    channelId,
                    guildId,
                });

                span.setAttribute("app.live_chain_length", messages.length);

                if (messages.length === 0) {
                    this.logger.debug(
                        { referencedMessageId },
                        "Live chain fetch returned no messages — proceeding without history",
                    );
                    return [];
                }

                const existingIds = await this.messageRepo.findExistingDiscordIds({
                    guildId,
                    channelId,
                    discordMessageIds: messages.map((m) => m.id),
                });
                const existingIdSet = new Set(existingIds);
                const newMessages = messages.filter((m) => !existingIdSet.has(m.id));

                span.setAttribute("app.live_chain_new_messages", newMessages.length);

                if (newMessages.length > 0) {
                    const built: Array<{
                        message: IChatClientMessage;
                        msg: BaseMessage;
                        ownBot: boolean;
                    }> = [];

                    for (const liveMsg of newMessages) {
                        const ownBot =
                            liveMsg.authorId === this.bot.userId ||
                            (this.previousBotId !== undefined && liveMsg.authorId === this.previousBotId);
                        const content = ownBot ? liveMsg.cleanContent : discordMessageToLlmText(liveMsg);

                        const attachments = [...liveMsg.attachments, ...(liveMsg.forwardedSnapshot?.attachments ?? [])];
                        const msg = await buildLangchainMessage({
                            role: ownBot ? "assistant" : "human",
                            content,
                            attachments,
                            embeds: liveMsg.embeds,
                            logger: this.logger,
                            guildId: liveMsg.guildId ?? "@me",
                            channelId: liveMsg.channelId,
                            discordMessageId: liveMsg.id,
                        });

                        built.push({ message: liveMsg, msg, ownBot });
                    }

                    await this.messageRepo.saveBatch(
                        built.map(({ message: liveMsg, msg, ownBot }) => ({
                            discordMessageId: liveMsg.id,
                            repliesToDiscordId: liveMsg.referencedMessageId,
                            channelId: liveMsg.channelId,
                            guildId: liveMsg.guildId ?? "@me",
                            role: ownBot ? "assistant" : ("human" as const),
                            discordAuthorId: liveMsg.authorId,
                            langchainMessages: [msg],
                            retriesLeft: null,
                            usedFallback: null,
                            interactionType: null,
                            interactionAuthorDiscordId: null,
                        })),
                    );
                }

                return this.messageRepo.fetchChain({
                    startDiscordMessageId: referencedMessageId,
                    channelId,
                    guildId,
                    limit,
                });
            },
        );
    }
}
