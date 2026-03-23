import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { Span } from "@sentry/core";
import {
    ActionRowBuilder,
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    type Client,
    ComponentType,
    Events,
    type Message,
    type MessageContextMenuCommandInteraction,
    MessageFlags,
    type TextBasedChannel,
    type TopLevelComponent,
} from "discord.js";
import { type FileConfig, SearchMode } from "../../application/config/AppConfig.ts";
import { agentStatusLabel } from "../../application/formatters/agentStatus.ts";
import { extractWebGroundingChunks, formatGroundingSources } from "../../application/formatters/groundingSources.ts";
import { splitMarkdown } from "../../application/formatters/markdownSplitter.ts";
import { llmTextToDiscordText } from "../../application/formatters/textTransformers.ts";
import { hasExtendedMarkdown } from "../../application/helpers/hasExtendedMarkdown.ts";
import { COMMAND_PREFIX_REGEX, parseMessageIntent } from "../../application/helpers/parseMessageIntent.ts";
import type { DiscordAttachmentInfo } from "../../application/ports/IAttachmentDownloader.ts";
import type { DiscordEmbedInfo } from "../../application/ports/IChatMessageService.ts";
import type { OnStatusUpdate } from "../../application/types/AgentStatus.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { GetNextPageUseCase } from "../../application/use-cases/GetNextPage.ts";
import type { HandleDiscordMessageUseCase } from "../../application/use-cases/HandleDiscordMessage.ts";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import type { MessageInteractionType } from "../../domain/message/Message.ts";
import { MessageIntent } from "../../domain/message/MessageIntent.ts";
import type { IMessagePageRepository } from "../../domain/message/MessagePage.ts";
import type { HtmlToImageRenderer } from "../exporters/HtmlToImageRenderer.ts";
import type { MarkdownToHtmlRenderer } from "../exporters/MarkdownToHtmlRenderer.ts";
import { shortenRedirectUrl } from "../http/redirectUrl.ts";
import { dbMessagesToLangchain, extractContent } from "../llm/utils/messageTransformers.ts";
import type { DiscordClient } from "./DiscordClient.ts";
import {
    EXPORT_HTML_COMMAND_NAME,
    EXPORT_IMAGE_COMMAND_NAME,
    SUMMARIZE_COMMAND_NAME,
} from "./DiscordCommandRegistry.ts";
import { InteractionLock } from "./InteractionLock.ts";
import { buildSnapshot, extractAttachments, extractEmbeds } from "./messageExtractors.ts";
import { RateLimiter } from "./RateLimiter.ts";
import type { StatusMessageUpdater } from "./StatusMessageUpdater.ts";

/** Discord's maximum message length in characters. */
const MESSAGE_LENGTH_LIMIT = 2000;

/** Sentinel value stored as guild_id for DM messages, which have no guild. */
const DM_GUILD_TOKEN = "@me";

/** Custom ID for the Retry button attached to failed bot responses. */
const RETRY_BUTTON_ID = "retry_mention";

/** Custom ID for the Next Page button attached to paginated bot responses. */
const NEXT_PAGE_BUTTON_ID = "next_page";

/** Custom ID for the Render button attached to responses containing extended markdown. */
const RENDER_BUTTON_ID = "render_image";

/**
 * Determines whether the bot was explicitly @mentioned in a Discord message,
 * as opposed to a mention-by-reply (where Discord auto-includes the replied-to user).
 *
 * Uses discord.js `mentions.has()` with `ignoreRepliedUser: true` to exclude
 * the implicit mention Discord adds when a user replies to one of the bot's messages.
 * Only responds when the user intentionally typed "@BotName" in the message content.
 *
 * @param message - The Discord message to check
 * @param botUserId - The bot's Discord user ID
 */
export function isExplicitMention(message: Message, botUserId: string): boolean {
    return message.mentions.has(botUserId, { ignoreRepliedUser: true });
}

/**
 * Strips bot @mention tokens, the bot's managed role mention token, and any leading
 * command prefix (e.g. `!ai`, `!aisearch`) from the message content in a single pass.
 *
 * Discord encodes user mentions as `<@userId>` or `<@!userId>` (legacy nickname format),
 * and role mentions as `<@&roleId>`. The bot's managed role ID is sourced from the guild
 * member object at call time, so only the bot's own role mention is stripped rather than
 * all role mentions. In DMs there are no role mentions, so `botRoleId` will be null and
 * the role-stripping step is skipped entirely.
 *
 * Command stripping is case-insensitive to accommodate phone auto-capitalization.
 * The command prefix is only stripped when it appears at the start of the content,
 * followed by at least one whitespace character.
 *
 * @param message - The Discord message
 * @param botUserId - The bot's Discord user ID
 * @param botRoleId - The bot's managed role ID in this guild, or null for DMs
 * @returns Trimmed message content without the bot's user/role mention tokens or command prefix
 */
export function extractUserContent(message: Message, botUserId: string, botRoleId: string | null): string {
    // Strip command prefix first — it always appears at the message start before any mention tokens
    const stripped = message.content.replace(COMMAND_PREFIX_REGEX, "");
    // Strip bot user mention (<@userId> / <@!userId>) and optionally the bot's role mention (<@&roleId>)
    const mentionPattern = botRoleId
        ? new RegExp(`<@!?${botUserId}>|<@&${botRoleId}>`, "g")
        : new RegExp(`<@!?${botUserId}>`, "g");
    return stripped.replace(mentionPattern, "").trim();
}

/**
 * Returns a components array with the button matching `removeId` filtered out.
 * Preserves all other buttons so, e.g., removing the Next Page button leaves
 * any co-located Retry button intact (and vice versa).
 * Passing the result to `message.edit({ components })` replaces the row in-place.
 */
function withoutButton(message: Message, removeId: string): (TopLevelComponent | ActionRowBuilder<ButtonBuilder>)[] {
    const result: (TopLevelComponent | ActionRowBuilder<ButtonBuilder>)[] = [];
    for (const row of message.components) {
        if (row.type !== ComponentType.ActionRow) {
            result.push(row);
            continue;
        }
        // Components from message.components are raw API objects; only buttons are ever
        // added by this bot, so filter to buttons only and wrap in ButtonBuilder so
        // ActionRowBuilder can serialize them correctly (label/emoji accessible).
        const remaining = row.components.filter(
            (c): c is (typeof row.components)[number] & { type: ComponentType.Button } =>
                c.type === ComponentType.Button && c.customId !== removeId,
        );
        if (remaining.length === 0) continue;
        result.push(
            new ActionRowBuilder<ButtonBuilder>({ components: remaining.map((c) => ButtonBuilder.from(c.toJSON())) }),
        );
    }
    return result;
}

/**
 * Manages Discord event dispatching for incoming messages and button interactions.
 *
 * Lifecycle (start/stop) is delegated to the injected {@link DiscordClient}, which
 * is solely responsible for the discord.js Client connection. The gateway saves a
 * direct reference to the underlying discord.js Client for use in event handlers.
 */
export class DiscordGateway {
    /** Saved reference to the underlying discord.js Client. */
    private readonly client: Client;
    private readonly defaultRetriesLeft: number;
    private readonly interactionLock = new InteractionLock();
    // used only in CreateMessage handler for now
    private readonly rateLimiter = new RateLimiter([
        { windowMs: 3_000, limit: 3 },
        { windowMs: 60_000, limit: 10 },
    ]);

    private previousBotId: string | undefined;
    private readonly searchMode: SearchMode;

    /** Set to true on graceful shutdown — prevents new handlers from starting. */
    private shutdownPending = false;
    /** Monotonically-increasing key for tracking in-flight handler promises. */
    private handlerCounter = 0;
    /** Tracks all currently in-flight async handlers; entries are removed on completion. */
    private readonly inFlightHandlers = new Map<number, Promise<void>>();

    constructor(
        discordClient: DiscordClient,
        private readonly handleDiscordMessageUseCase: HandleDiscordMessageUseCase,
        private readonly logger: Logger,
        private readonly statusUpdater: StatusMessageUpdater,
        private readonly messagePageRepo: IMessagePageRepository,
        private readonly getNextPageUseCase: GetNextPageUseCase,
        private readonly messageRepo: IMessageRepository,
        config: Pick<FileConfig, "discord" | "agent">,
        private readonly markdownToHtml: MarkdownToHtmlRenderer,
        private readonly htmlToImage: HtmlToImageRenderer,
    ) {
        this.client = discordClient.client;
        this.defaultRetriesLeft = config.discord.defaultRetriesLeft;
        this.previousBotId = config.discord.previousBotId;
        this.searchMode = config.agent.nodes.search.mode;
        this.registerEventHandlers();
    }

    private registerEventHandlers(): void {
        this.client.on(Events.MessageCreate, (message) => {
            this.trackHandler(this.handleMessageCreate(message));
        });

        this.client.on(Events.InteractionCreate, (interaction) => {
            if (this.shutdownPending && !interaction.isAutocomplete()) {
                void interaction
                    .reply({ content: "*A restart is pending, try again later.*", flags: MessageFlags.Ephemeral })
                    .catch(() => {});
                return;
            }

            if (interaction.isMessageContextMenuCommand()) {
                if (interaction.commandName === SUMMARIZE_COMMAND_NAME) {
                    this.trackHandler(this.handleSummarizeContextMenu(interaction));
                } else if (interaction.commandName === EXPORT_HTML_COMMAND_NAME) {
                    this.trackHandler(this.handleExportHtmlContextMenu(interaction));
                } else if (interaction.commandName === EXPORT_IMAGE_COMMAND_NAME) {
                    this.trackHandler(this.handleExportImageContextMenu(interaction));
                }
                return;
            }

            if (!interaction.isButton()) return;
            if (interaction.customId === RETRY_BUTTON_ID) {
                this.trackHandler(this.handleRetryButton(interaction));
            } else if (interaction.customId === NEXT_PAGE_BUTTON_ID) {
                this.trackHandler(this.handleNextPageButton(interaction));
            } else if (interaction.customId === RENDER_BUTTON_ID) {
                this.trackHandler(this.handleRenderButton(interaction));
            }
        });

        this.client.on(Events.Error, (err) => {
            this.logger.error({ err }, "Discord client error");
            Sentry.captureException(err);
        });
    }

    /**
     * Registers an in-flight handler promise so {@link gracefulShutdown} can await it.
     * The entry is removed from the map once the promise settles.
     */
    private trackHandler(promise: Promise<void>): void {
        const id = this.handlerCounter++;
        this.inFlightHandlers.set(
            id,
            promise.finally(() => this.inFlightHandlers.delete(id)),
        );
    }

    /**
     * Prevents new handlers from starting and waits for all in-flight handlers to settle.
     * Called during graceful shutdown before the process exits.
     */
    async gracefulShutdown(): Promise<void> {
        this.shutdownPending = true;
        this.logger.info({ inFlight: this.inFlightHandlers.size }, "Waiting for in-flight handlers to complete");
        await Promise.allSettled(this.inFlightHandlers.values());
        this.logger.info("All in-flight handlers completed");
    }

    /**
     * Resolves grounding web sources from the final AIMessage in newMessages.
     *
     * Only the last message is inspected — it is the one whose content is displayed
     * to the user, and the one the orchestrator's `extractContent` reads from.
     * NOTE: grounding sources on any intermediary AIMessages (e.g. a triage response
     * that also happened to use search) are intentionally omitted.
     *
     * Extracts `groundingMetadata.groundingChunks[].web` entries, shortens each
     * redirect URL, and formats them as a Discord Markdown sources string.
     * Returns `null` if the last message is not an AIMessage, has no web sources,
     * or formatting produces nothing.
     */
    /**
     * Shared post-processing step after the LLM produces a response.
     *
     * Handles: cancelling/deleting the thinking placeholder, applying the LLM→Discord
     * text transform, splitting paginated responses, building action row buttons,
     * sending the bot reply, saving it to the database, and persisting page state.
     *
     * When the response used Google Search grounding (searchNode), any web source
     * citations are appended to the reply (non-paginated path) or sent as a
     * follow-up reply (paginated path and when combined length exceeds 2000 chars).
     * The sources message is persisted to the DB so it can be replied to.
     *
     * Called by both {@link handleMessageCreate} and {@link handleRetryButton} so neither
     * duplicates the pagination or persistence logic.
     *
     * @param params.replyTarget - The user's original Discord message to reply to
     * @param params.response - Raw LLM response string (before Discord text transform)
     * @param params.newMessages - All LangChain messages generated during this turn
     * @param params.isFailure - Whether the response represents a failure
     * @param params.isRetryable - Whether a Retry button should be attached
     * @param params.usedFallback - Whether the response was generated by a fallback model
     * @param params.thinkingMessage - Thinking placeholder to cancel and delete before sending
     * @param params.span - Active Sentry span for attribute recording
     */
    private async sendBotReply(params: {
        replyTarget: Message;
        response: string;
        newMessages: BaseMessage[];
        isFailure?: boolean;
        isRetryable?: boolean;
        usedFallback?: boolean;
        /**
         * Retries remaining for this response. Only meaningful when isRetryable is true.
         * When undefined/null and isRetryable is true, defaults to defaultRetriesLeft.
         * When 0 the Retry button is suppressed entirely.
         */
        retriesLeft?: number | null;
        thinkingMessagePromise: ReturnType<Message["reply"]>;
        span: Span;
        /** Whether to ping the author of replyTarget. Defaults to true. */
        pingUser?: boolean;
        /** Text to prepend to the response content (e.g. a user mention). */
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

        // Resolve grounding sources in parallel with the response being sent.
        // Only populated when the response came from the searchNode (Google Search grounding).
        const sourcesLine = await this.resolveGroundingSources(newMessages);

        // Attach a Retry button when the use case signals a retryable failure and retries remain.
        // retriesLeft=undefined means this is a fresh response — use defaultRetriesLeft.
        // retriesLeft=0 means all retries exhausted — suppress the button.
        const effectiveRetriesLeft = retriesLeft ?? this.defaultRetriesLeft;
        const retryRow =
            isRetryable && effectiveRetriesLeft > 0
                ? new ActionRowBuilder<ButtonBuilder>().addComponents(
                      new ButtonBuilder()
                          .setCustomId(RETRY_BUTTON_ID)
                          .setLabel(
                              `Retry · ${effectiveRetriesLeft} ${effectiveRetriesLeft === 1 ? "Retry" : "Retries"} Left`,
                          )
                          .setStyle(isFailure ? ButtonStyle.Primary : ButtonStyle.Secondary),
                  )
                : undefined;

        // Attach a Render button when the full response contains extended markdown features
        // (LaTeX equations or tables) that benefit from rich rendering.
        const renderButton = hasExtendedMarkdown(response)
            ? new ButtonBuilder().setCustomId(RENDER_BUTTON_ID).setLabel("Render").setStyle(ButtonStyle.Secondary)
            : undefined;

        // Space reserved on the first page for replyPrefix (+ trailing space) and fallbackFooter.
        const page1Overhead = (replyPrefix ? replyPrefix.length + 1 : 0) + fallbackFooter.length;

        if (discordResponse.length + page1Overhead > MESSAGE_LENGTH_LIMIT) {
            // --- PAGINATED PATH ---
            // Split on discordResponse (without footer) so the newOffset stored in the DB
            // is always relative to discordResponse. The footer is appended to page1Content
            // after the split so it appears at the bottom of the first page and is never cut off.
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

            // When both a Next Page and Retry button are present, combine them into
            // a single row so they render side by side (Next Page first).
            const firstPageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(NEXT_PAGE_BUTTON_ID)
                    .setLabel(`Next Page · Page 1 of ${totalPages}`)
                    .setStyle(ButtonStyle.Primary),
                ...(retryRow ? retryRow.components : []),
                ...(renderButton ? [renderButton] : []),
            );

            const components: ActionRowBuilder<ButtonBuilder>[] = [firstPageRow];

            const botReply = await replyTarget.reply({
                content: (replyPrefix ? `${replyPrefix} ` : "") + page1Content + fallbackFooter,
                components,
                // repliedUser: false suppresses the reply ping but also causes Discord to
                // ignore all content mentions unless explicitly listed in users[].
                // Include the invoker so the <@id> prefix still triggers a notification.
                ...(!pingUser && {
                    allowedMentions: {
                        repliedUser: false,
                        ...(interactionAuthorDiscordId && { users: [interactionAuthorDiscordId] }),
                    },
                }),
            });

            span.setAttributes({
                "discord.paginated": true,
                "discord.total_pages": totalPages,
            });

            // messages row must exist before messagePageRepo.save (FK constraint)
            const savedBotMsg = await this.messageRepo.saveAssistantMessage({
                discordMessageId: botReply.id,
                repliesToDiscordId: replyTarget.id,
                channelId: botReply.channelId,
                guildId: botReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.client.user?.id ?? "",
                newMessages,
                retriesLeft: isRetryable ? effectiveRetriesLeft : null,
                usedFallback: usedFallback ?? false,
                interactionType: interactionType ?? null,
                interactionAuthorDiscordId: interactionAuthorDiscordId ?? null,
            });
            // messageId = UUID of the saved messages row for this page; firstPageMessageId = same for page 1
            await this.messagePageRepo.save({
                messageId: savedBotMsg.id,
                firstPageMessageId: savedBotMsg.id,
                endOffset: newOffset,
                currentPage: 1,
                totalPages,
                endedInCodeBlock: page1EndedInCodeBlock,
                codeBlockType: page1CodeBlockType,
            });

            // In the paginated path, send sources as a separate follow-up reply
            if (sourcesLine) {
                await this.sendSourcesReply(botReply, sourcesLine);
            }
        } else {
            // --- NON-PAGINATED PATH ---

            // Attempt to combine response + footer + sources into a single message
            const responseWithFooter = discordResponse + fallbackFooter;
            const combined =
                sourcesLine && responseWithFooter.length + 1 + sourcesLine.length <= MESSAGE_LENGTH_LIMIT
                    ? `${responseWithFooter}\n${sourcesLine}`
                    : null;

            const singleRow = new ActionRowBuilder<ButtonBuilder>();
            if (retryRow) singleRow.addComponents(...retryRow.components);
            if (renderButton) singleRow.addComponents(renderButton);
            const nonPaginatedComponents = singleRow.components.length > 0 ? [singleRow] : [];

            const botReply = await replyTarget.reply({
                content: (replyPrefix ? `${replyPrefix} ` : "") + (combined ?? responseWithFooter),
                ...(nonPaginatedComponents.length > 0 && { components: nonPaginatedComponents }),
                ...(!pingUser && {
                    allowedMentions: {
                        repliedUser: false,
                        ...(interactionAuthorDiscordId && { users: [interactionAuthorDiscordId] }),
                    },
                }),
            });

            span.setAttributes({ "discord.paginated": false });

            await this.messageRepo.saveAssistantMessage({
                discordMessageId: botReply.id,
                repliesToDiscordId: replyTarget.id,
                channelId: botReply.channelId,
                guildId: botReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.client.user?.id ?? "",
                newMessages,
                retriesLeft: isRetryable ? effectiveRetriesLeft : null,
                usedFallback: usedFallback ?? false,
                interactionType: interactionType ?? null,
                interactionAuthorDiscordId: interactionAuthorDiscordId ?? null,
            });

            // Sources didn't fit in the main message — send as a separate follow-up reply
            if (sourcesLine && !combined) {
                await this.sendSourcesReply(botReply, sourcesLine);
            }
        }

        span.setAttributes({
            "discord.response_length": response.length,
            "discord.is_failure": isFailure ?? false,
        });
    }

    // NOTE: A naive implementation for a rare usecase, could be made more robust by extending the database
    /**
     * After deleting a bot message on Retry, opportunistically deletes any dangling
     * sources follow-up that replied to it. Web Search responses send a separate
     * "*Sources: …*" message that would otherwise be left orphaned.
     *
     * Fetches up to 10 messages sent after the deleted message in the same channel,
     * finds the first one that is the bot's own message, replies to the deleted
     * message, and starts with "*Sources: " — then deletes it from Discord and the DB.
     *
     * Intentionally fire-and-forget: errors are logged but never propagate.
     *
     * @param channel - The text channel the deleted message was in
     * @param deletedMessageId - Snowflake ID of the message that was just deleted
     * @param channelId - Channel ID for DB deletion
     * @param guildId - Guild ID for DB deletion
     */
    private deleteDanglingSourcesMessageOptimistically(
        channel: TextBasedChannel,
        deletedMessageId: string,
        channelId: string,
        guildId: string,
    ): void {
        const botId = this.client.user?.id;

        channel.messages
            .fetch({ after: deletedMessageId, limit: 10 })
            .then((fetched) => {
                const sourcesMsg = fetched.find(
                    (msg) =>
                        msg.author.id === botId &&
                        msg.reference?.messageId === deletedMessageId &&
                        // NOTE this might drift from sources message formatting
                        msg.content.startsWith("*Sources: "),
                );
                if (!sourcesMsg) return;

                // Delete from Discord — fire-and-forget
                sourcesMsg.delete().catch((err) => {
                    this.logger.warn({ err }, "Failed to delete dangling sources message from Discord on retry");
                });

                // Delete from DB — fire-and-forget
                this.messageRepo
                    .deleteByDiscordMessageId({ discordMessageId: sourcesMsg.id, channelId, guildId })
                    .catch((err) => {
                        this.logger.warn({ err }, "Failed to delete dangling sources message from DB on retry");
                    });
            })
            .catch((err) => {
                this.logger.warn({ err }, "Failed to fetch messages when cleaning up dangling sources on retry");
            });
    }

    /**
     * Sends a sources-only follow-up reply and persists it to the DB so it
     * participates in the reply chain.
     *
     * No `newMessages` are stored for this row — it is a display-only message
     * that contains no LangChain-generated content.
     *
     * @param replyTo - The bot message to reply to
     * @param sourcesLine - The formatted sources string (≤ 2000 chars)
     */
    private async sendSourcesReply(replyTo: Message, sourcesLine: string): Promise<void> {
        try {
            const sourcesReply = await replyTo.reply({ content: sourcesLine });
            await this.messageRepo.saveAssistantMessage({
                discordMessageId: sourcesReply.id,
                repliesToDiscordId: replyTo.id,
                channelId: sourcesReply.channelId,
                guildId: sourcesReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.client.user?.id ?? "",
                newMessages: [],
                retriesLeft: null,
                usedFallback: false,
                interactionType: null,
                interactionAuthorDiscordId: null,
            });
        } catch (err) {
            this.logger.warn({ err }, "Failed to send grounding sources reply");
        }
    }

    /**
     * Handles a Retry button click on a failed bot response.
     *
     * Two scenarios:
     * - **Scenario A** (human message in DB): the failure occurred in the orchestrator.
     *   Re-runs only the orchestration using the saved conversation chain. Skips
     *   attachment re-download/re-upload and human message re-save.
     * - **Scenario B** (human message NOT in DB): the failure occurred before or during
     *   the human message save (e.g. attachment download/upload failure, DB error).
     *   Falls back to the full message handling pipeline.
     *
     * In both scenarios, the old failed bot reply is deleted before sending a new response.
     */
    private async handleRetryButton(interaction: ButtonInteraction): Promise<void> {
        const originalMessageId = interaction.message.reference?.messageId;
        const channel = interaction.channel;

        let originalMessage: Message | undefined;
        if (originalMessageId && channel?.isTextBased()) {
            try {
                originalMessage = await channel.messages.fetch(originalMessageId);
            } catch {
                // fetch failed — original message was deleted
            }
        }

        if (!originalMessage) {
            // Original message is gone or unreachable — remove the button and notify ephemerally
            await Promise.allSettled([
                interaction.reply({
                    content: "Original message is missing, retry is no longer possible.",
                    flags: MessageFlags.Ephemeral,
                }),
                interaction.message.edit({
                    components: withoutButton(interaction.message, RETRY_BUTTON_ID),
                }),
            ]);
            return;
        }

        // Acknowledge the interaction immediately so Discord doesn't show "interaction failed"
        await interaction.deferUpdate();

        await Sentry.startSpan(
            {
                name: "Handle Retry button",
                op: "discord.interaction.retry",
                attributes: {
                    "discord.original_message_id": originalMessage.id,
                    "discord.channel_id": originalMessage.channelId,
                },
            },
            async (span) => {
                // Fetch the tail of the reply chain starting from the failed bot reply.
                // With limit=2 we get at most [humanMsg, botReply] in chronological order.
                // The bot reply record (last) carries retriesLeft, usedFallback, and interactionType;
                // the human record (second-to-last) confirms whether the human message was saved
                // (Scenario A vs B) and provides the original author ID for the eligibility check.
                const guildId = originalMessage.guildId ?? DM_GUILD_TOKEN;
                const chain = await this.messageRepo.fetchChain({
                    startDiscordMessageId: interaction.message.id,
                    channelId: originalMessage.channelId,
                    guildId,
                    limit: 2,
                });

                // chain is ordered chronologically: [humanMsg, botReply] when both exist,
                // or [botReply] / [] when the human message was never saved (Scenario B).
                const botRecord = chain.at(-1);
                const humanRecord = chain.length >= 2 ? chain.at(-2) : undefined;

                // Decrement retriesLeft from the stored bot reply row — each click consumes one retry.
                // null if not set or record missing (sendBotReply will fall back to defaultRetriesLeft).
                const storedRetriesLeft = botRecord?.retriesLeft ?? null;
                const retriesLeft = storedRetriesLeft !== null ? storedRetriesLeft - 1 : null;

                // Reconstruct intent and reply options from the stored interaction type.
                // For summary_command the original message has no command prefix, so parseMessageIntent
                // would return UNKNOWN — we must use the DB value instead.
                const isSummaryCommand = botRecord?.interactionType === "summary_command";
                const intent = isSummaryCommand ? MessageIntent.SUMMARY : parseMessageIntent(originalMessage.content);

                // Mirror the self-reply logic from handleSummarizeContextMenu: if the invoker
                // is the same user as the message author, Discord's reply mechanism already pings
                // them and allowedMentions.repliedUser suppression would strip an explicit prefix.
                const isSelfReply =
                    isSummaryCommand && botRecord?.interactionAuthorDiscordId === humanRecord?.discordAuthorId;
                const pingUser = !isSummaryCommand || isSelfReply;
                const replyPrefix =
                    isSummaryCommand && !isSelfReply && botRecord?.interactionAuthorDiscordId
                        ? `<@${botRecord.interactionAuthorDiscordId}>`
                        : undefined;

                // Gate: when the response was a successful fallback (usedFallback=true, isFailure=false),
                // only the original prompter may retry — it's their call whether the response is
                // unsatisfactory. Failed responses are open to anyone since retrying benefits all.
                if (botRecord?.usedFallback && humanRecord?.role === "human") {
                    const originalAuthorId = humanRecord.discordAuthorId;
                    if (interaction.user.id !== originalAuthorId) {
                        await interaction.followUp({
                            content: "*This message was generated for someone else and can only be retried by them.*",
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }
                }

                // Acquire the per-button lock only for eligible interactions, so ineligible users
                // (checked above) don't block the real prompter from clicking.
                if (this.interactionLock.isLocked(interaction.message.id, interaction.customId)) {
                    span.setAttribute("discord.retry_skipped", "locked");
                    return;
                }
                this.interactionLock.setLocked(interaction.message.id, interaction.customId);
                try {
                    // Delete the old failed bot reply from Discord before sending a fresh response.
                    // DB deletion happens later after retriesLeft has been read.
                    await interaction.message.delete().catch((err) => {
                        this.logger.warn({ err }, "Failed to delete old failed bot reply from Discord on retry");
                    });

                    // If the deleted message had a sources follow-up, clean it up too.
                    if (interaction.channel) {
                        this.deleteDanglingSourcesMessageOptimistically(
                            interaction.channel,
                            interaction.message.id,
                            originalMessage.channelId,
                            guildId,
                        );
                    }

                    // Delete the old failed bot reply from DB now that retriesLeft has been read.
                    // Fire-and-forget — failure here doesn't block the retry from proceeding.
                    this.messageRepo
                        .deleteByDiscordMessageId({
                            discordMessageId: interaction.message.id,
                            channelId: originalMessage.channelId,
                            guildId,
                        })
                        .catch((err) => {
                            this.logger.warn({ err }, "Failed to delete old failed bot reply from DB on retry");
                        });

                    if (humanRecord?.role === "human") {
                        // --- Scenario A: human message exists, re-run orchestration only ---
                        // reuseHumanMessage skips re-building/re-persisting the human message row
                        // and reconstructs the full conversation chain from DB instead.
                        span.setAttribute("discord.retry_scenario", "A");
                        const botUserId = this.client.user?.id;
                        if (!botUserId) throw new Error("Missing bot ID. This shouldn't happen.");
                        await this.invokeAgentWithMessage({
                            message: originalMessage,
                            botUserId,
                            userContent: null,
                            attachments: null,
                            intent,
                            retriesLeft,
                            pingUser,
                            replyPrefix,
                            interactionType: botRecord?.interactionType ?? "message_create",
                            interactionAuthorDiscordId: botRecord?.interactionAuthorDiscordId ?? undefined,
                            thinkingText: "Retrying",
                            reuseHumanMessage: true,
                        });
                    } else {
                        // --- Scenario B: human message not in DB, run full pipeline ---
                        span.setAttribute("discord.retry_scenario", "B");
                        await this.handleMessageCreate(originalMessage, retriesLeft);
                    }
                } finally {
                    this.interactionLock.clearLock(interaction.message.id, interaction.customId);
                }
            },
        );
    }

    /**
     * Handles a Next Page button click on a paginated bot response.
     *
     * Retrieves the pending page state from the DB via the GetNextPage use case,
     * sends the next page as a Discord reply to the current bot message, updates
     * the DB state, and removes the button from the old message.
     *
     * If the page state is missing (e.g. stale button), removes the button and returns.
     */
    private async handleNextPageButton(interaction: ButtonInteraction): Promise<void> {
        if (this.interactionLock.isLocked(interaction.message.id, interaction.customId)) {
            await interaction.deferUpdate();
            return;
        }
        this.interactionLock.setLocked(interaction.message.id, interaction.customId);
        try {
            // Acknowledge immediately to prevent Discord's "interaction failed" timeout
            await interaction.deferUpdate();

            const currentBotMessageId = interaction.message.id;

            await Sentry.startSpan(
                {
                    name: "Handle Next Page button",
                    op: "discord.interaction.next_page",
                    attributes: { "discord.message_id": currentBotMessageId },
                },
                async (span) => {
                    // Step 1: Compute next page content via use case
                    let result: Awaited<ReturnType<GetNextPageUseCase["execute"]>>;
                    try {
                        result = await this.getNextPageUseCase.execute({
                            discordMessageId: currentBotMessageId,
                            channelId: interaction.message.channelId,
                            guildId: interaction.message.guildId ?? DM_GUILD_TOKEN,
                            messageLengthLimit: MESSAGE_LENGTH_LIMIT,
                        });
                    } catch (err) {
                        this.logger.error({ err, currentBotMessageId }, "Failed to compute next page");
                        Sentry.captureException(err);
                        await interaction.message
                            .edit({ components: withoutButton(interaction.message, NEXT_PAGE_BUTTON_ID) })
                            .catch(() => {});
                        return;
                    }

                    if (!result) {
                        // No pending page state — stale button click
                        await interaction.message
                            .edit({ components: withoutButton(interaction.message, NEXT_PAGE_BUTTON_ID) })
                            .catch((err) => {
                                this.logger.warn(
                                    { err, currentBotMessageId },
                                    "Failed to remove stale Next Page button",
                                );
                            });
                        return;
                    }

                    span.setAttributes({
                        "discord.page": result.currentPage,
                        "discord.total_pages": result.totalPages,
                        "discord.is_last_page": result.isLast,
                    });

                    // Step 2: Build component row for next message (omit button on last page)
                    const nextPageRow = result.isLast
                        ? undefined
                        : new ActionRowBuilder<ButtonBuilder>().addComponents(
                              new ButtonBuilder()
                                  .setCustomId(NEXT_PAGE_BUTTON_ID)
                                  .setLabel(`Next Page · Page ${result.currentPage} of ${result.totalPages}`)
                                  .setStyle(ButtonStyle.Primary),
                          );

                    // Step 3: Send the next page as a reply to the current bot message
                    let newBotMessage: Awaited<ReturnType<Message["reply"]>>;
                    try {
                        newBotMessage = await interaction.message.reply({
                            content: result.content,
                            ...(nextPageRow && { components: [nextPageRow] }),
                        });
                    } catch (err) {
                        this.logger.error({ err, currentBotMessageId }, "Failed to send next page reply");
                        Sentry.captureException(err);
                        return;
                    }

                    // Step 4: Persist the messages row first — messagePageRepo.save has a FK on it,
                    // so if this throws the remaining cleanup is skipped entirely.
                    const savedNextBotMsg = await this.messageRepo.saveAssistantMessage({
                        discordMessageId: newBotMessage.id,
                        repliesToDiscordId: currentBotMessageId,
                        channelId: newBotMessage.channelId,
                        guildId: newBotMessage.guildId ?? DM_GUILD_TOKEN,
                        discordAuthorId: this.client.user?.id ?? "",
                        newMessages: [],
                        retriesLeft: null,
                        usedFallback: false,
                        interactionType: null,
                        interactionAuthorDiscordId: null,
                    });

                    await Promise.allSettled([
                        // Save new pending page state if there are more pages after this one.
                        // firstPageMessageId is propagated from the page state so all rows
                        // in this response chain point to the same first-page messages row.
                        !result.isLast
                            ? this.messagePageRepo
                                  .save({
                                      messageId: savedNextBotMsg.id,
                                      firstPageMessageId: result.firstPageMessageId,
                                      endOffset: result.newOffset,
                                      currentPage: result.currentPage,
                                      totalPages: result.totalPages,
                                      endedInCodeBlock: result.endedInCodeBlock,
                                      codeBlockType: result.codeBlockType,
                                  })
                                  .catch((err) => {
                                      this.logger.error({ err }, "Failed to save next message page state");
                                  })
                            : Promise.resolve(),

                        // Remove only the Next Page button from the OLD bot message,
                        // preserving any Retry button that may also be present.
                        interaction.message
                            .edit({ components: withoutButton(interaction.message, NEXT_PAGE_BUTTON_ID) })
                            .catch((err) => {
                                this.logger.warn(
                                    { err, currentBotMessageId },
                                    "Failed to remove Next Page button from old message",
                                );
                            }),
                    ]);

                    this.logger.info(
                        {
                            currentBotMessageId,
                            newBotMessageId: newBotMessage.id,
                            page: result.currentPage,
                            totalPages: result.totalPages,
                        },
                        "Sent next page",
                    );
                },
            );
        } finally {
            this.interactionLock.clearLock(interaction.message.id, interaction.customId);
        }
    }

    /**
     * Handles the Summarize message context menu command.
     *
     * Fetches the target message, acknowledges the interaction ephemerally, then
     * invokes the agent with SUMMARY intent. The bot reply is sent as a reply to the
     * target message and prefixed with a mention of the invoker.
     */
    private async handleSummarizeContextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
        const botUserId = this.client.user?.id;
        if (!botUserId) throw new Error("Missing bot ID. This shouldn't happen.");

        const targetMessage = interaction.targetMessage;
        const attachments = extractAttachments(targetMessage);
        const embeds = extractEmbeds(targetMessage);
        const botRoleId = targetMessage.guild?.members.me?.roles.botRole?.id ?? null;
        const userContent = extractUserContent(targetMessage, botUserId, botRoleId);

        // ACK the interaction with a visible ephemeral reply so Discord doesn't show
        // "interaction failed". Deleted after 5 seconds — the thinking placeholder on
        // the target message is the real visual feedback.
        await interaction.reply({ content: "*Generating summary...*", flags: MessageFlags.Ephemeral });
        setTimeout(() => void interaction.deleteReply().catch(() => {}), 5_000);

        // When the invoker is also the message author, replying to their own message already
        // pings them via Discord's reply mechanism — no explicit mention prefix needed, and
        // allowedMentions.repliedUser suppression would strip it anyway.
        const isSelfReply = interaction.user.id === targetMessage.author.id;
        const pingUser = isSelfReply;
        const replyPrefix = isSelfReply ? undefined : `<@${interaction.user.id}>`;

        // If this message was already saved (e.g. summarized before), skip re-inserting
        // the human message row — reuse the existing DB record instead.
        const reuseHumanMessage = await this.messageRepo.existsByDiscordMessageId({
            discordMessageId: targetMessage.id,
            channelId: targetMessage.channelId,
            guildId: targetMessage.guildId ?? DM_GUILD_TOKEN,
        });

        await this.invokeAgentWithMessage({
            message: targetMessage,
            botUserId,
            userContent,
            attachments,
            embeds,
            intent: MessageIntent.SUMMARY,
            pingUser,
            replyPrefix,
            interactionType: "summary_command",
            interactionAuthorDiscordId: interaction.user.id,
            reuseHumanMessage,
            fetchHistory: false,
            // TODO: add a language preference to config
            ephemeralInstructionMessage: "Summarize this in English",
        });
    }

    /** Handles the "Export as HTML" message context menu command. */
    private async handleExportHtmlContextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
        const botUserId = this.client.user?.id;
        if (!botUserId) throw new Error("Missing bot ID. This shouldn't happen.");

        const target = interaction.targetMessage;

        // Only allow exporting messages authored by this bot or the previous bot
        if (target.author.id !== botUserId && target.author.id !== this.previousBotId) {
            await interaction.reply({ content: "*You can only export bot messages.*", flags: MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const markdown = await this.resolveExportContent(target);
        const html = this.markdownToHtml.render(markdown);
        const filename = `render-${target.id}.html`;

        await interaction.editReply({
            files: [{ attachment: Buffer.from(html, "utf-8"), name: filename }],
        });
    }

    /** Handles the "Export as Image" message context menu command. */
    private async handleExportImageContextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
        const botUserId = this.client.user?.id;
        if (!botUserId) throw new Error("Missing bot ID. This shouldn't happen.");

        const target = interaction.targetMessage;

        // Only allow exporting messages authored by this bot or the previous bot
        if (target.author.id !== botUserId && target.author.id !== this.previousBotId) {
            await interaction.reply({ content: "*You can only export bot messages.*", flags: MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const markdown = await this.resolveExportContent(target);
        const html = this.markdownToHtml.render(markdown);
        const png = await this.htmlToImage.render(html);
        const filename = `render-${target.id}.png`;

        await interaction.editReply({
            files: [{ attachment: png, name: filename }],
        });
    }

    /** Handles the "Render" button attached to bot replies containing extended markdown. */
    private async handleRenderButton(interaction: ButtonInteraction): Promise<void> {
        const botMessage = interaction.message;

        if (this.interactionLock.isLocked(botMessage.id, RENDER_BUTTON_ID)) {
            await interaction.reply({ content: "*Already rendering, please wait.*", flags: MessageFlags.Ephemeral });
            return;
        }

        this.interactionLock.setLocked(botMessage.id, RENDER_BUTTON_ID);
        try {
            // Acknowledge the button press without creating an interaction reply — the
            // rendered image will be sent as a normal reply to the bot message instead.
            await interaction.deferUpdate();

            const markdown = await this.resolveExportContent(botMessage);
            const html = this.markdownToHtml.render(markdown);
            const png = await this.htmlToImage.render(html);
            const filename = `render-${botMessage.id}.png`;

            const renderReply = await botMessage.reply({
                files: [{ attachment: png, name: filename }],
                allowedMentions: { repliedUser: false },
            });

            // Persist so the render reply participates in the DB reply chain
            await this.messageRepo.saveAssistantMessage({
                discordMessageId: renderReply.id,
                repliesToDiscordId: botMessage.id,
                channelId: renderReply.channelId,
                guildId: renderReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.client.user?.id ?? "",
                newMessages: [],
                retriesLeft: null,
                usedFallback: false,
                interactionType: "message_create",
                interactionAuthorDiscordId: interaction.user.id,
            });

            // Remove the Render button from the original message now that it's been rendered
            await botMessage.edit({ components: withoutButton(botMessage, RENDER_BUTTON_ID) });
        } finally {
            this.interactionLock.clearLock(botMessage.id, RENDER_BUTTON_ID);
        }
    }

    /**
     * Resolves the full markdown content for a bot message to export.
     *
     * Looks up the DB row for the target message and extracts text from its
     * persisted LangChain messages (which may contain the full multi-page content).
     * Falls back to the Discord message content if no DB row exists.
     */
    private async resolveExportContent(target: Message): Promise<string> {
        const guildId = target.guildId ?? DM_GUILD_TOKEN;
        const row = await this.messageRepo.findByDiscordMessageId({
            discordMessageId: target.id,
            channelId: target.channelId,
            guildId,
        });

        if (row && row.langchainMessages.length > 0) {
            // Find the last AI message in the stored LangChain messages and extract its content
            const langchainMessages = dbMessagesToLangchain([row], this.logger);
            // Walk from the end to find the last substantive AI response
            for (let i = langchainMessages.length - 1; i >= 0; i--) {
                const msg = langchainMessages[i];
                if (msg === undefined) continue;
                const content = extractContent(msg);
                if (content.trim().length > 0) return content;
            }
        }

        // Fallback: use the raw Discord message content
        return target.cleanContent;
    }

    private async handleMessageCreate(message: Message, retriesLeft?: number | null): Promise<void> {
        // Ignore all bot messages (including our own) to prevent feedback loops
        if (message.author.bot) return;

        const botUserId = this.client.user?.id;
        if (!botUserId) throw new Error("Missing bot ID. This shouldn't happen.");

        // botRole is the managed role Discord auto-creates for the bot in each guild; null in DMs
        const botRoleId = message.guild?.members.me?.roles.botRole?.id ?? null;
        // Parse intent from raw content before stripping, so the command prefix is visible
        const intent = parseMessageIntent(message.content);

        // Only respond to explicit @mentions or recognized command prefixes
        if (intent === MessageIntent.UNKNOWN && !isExplicitMention(message, botUserId)) return;

        if (this.shutdownPending) {
            const reply = await message.reply("*A restart is pending, try again later.*");
            await this.messageRepo.saveAssistantMessage({
                discordMessageId: reply.id,
                repliesToDiscordId: message.id,
                channelId: reply.channelId,
                guildId: reply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.client.user?.id ?? "",
                newMessages: [],
                retriesLeft: null,
                usedFallback: false,
                interactionType: null,
                interactionAuthorDiscordId: null,
            });
            return;
        }

        const rateLimit = this.rateLimiter.check(message.author.id);
        if (!rateLimit.allowed) {
            const rateLimitReply = await message.reply(
                "Hi! It seems you have sent too many messages at once recently. Please wait a while before sending more.",
            );
            await this.messageRepo.saveAssistantMessage({
                discordMessageId: rateLimitReply.id,
                repliesToDiscordId: message.id,
                channelId: rateLimitReply.channelId,
                guildId: rateLimitReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.client.user?.id ?? "",
                newMessages: [],
                retriesLeft: null,
                usedFallback: false,
                interactionType: null,
                interactionAuthorDiscordId: null,
            });
            return;
        }
        const userContent = extractUserContent(message, botUserId, botRoleId);
        const attachments: DiscordAttachmentInfo[] = extractAttachments(message);

        // No usable content after stripping mentions/commands, no attachments, and no reply
        // reference — substitute a synthetic greeting so the agent can introduce itself.
        // When the message is a reply, context comes from the reply chain; skip the greeting.
        const effectiveUserContent =
            !userContent && attachments.length === 0 && !message.reference?.messageId
                ? "Hi, can you introduce yourself?"
                : userContent;

        this.logger.info(
            {
                discordMessageId: message.id,
                channelId: message.channelId,
                referencedMessageId: message.reference?.messageId ?? null,
                attachmentCount: attachments.length,
            },
            "Processing bot message",
        );

        await this.invokeAgentWithMessage({
            message,
            botUserId,
            userContent: effectiveUserContent,
            attachments,
            intent,
            retriesLeft,
            interactionType: "message_create",
        });
    }

    /**
     * Core agent invocation shared by {@link handleMessageCreate} and
     * {@link handleSummarizeContextMenu}. Sends a thinking placeholder, runs the
     * use case, and calls {@link sendBotReply} with the result.
     */
    private async invokeAgentWithMessage(params: {
        /** The Discord message to reply to (thinking placeholder and bot reply are sent as replies to this). */
        message: Message;
        botUserId: string;
        userContent: string | null;
        attachments: DiscordAttachmentInfo[] | null;
        embeds?: DiscordEmbedInfo[];
        intent: MessageIntent;
        retriesLeft?: number | null;
        /** Whether to ping the author of message in the bot reply. Defaults to true. */
        pingUser?: boolean;
        /** Text to prepend to the bot reply content (e.g. a user mention). */
        replyPrefix?: string;
        interactionType?: MessageInteractionType;
        interactionAuthorDiscordId?: string;
        /** Label shown in the thinking placeholder (e.g. "Thinking" or "Retrying"). Defaults to "Thinking". */
        thinkingText?: string;
        reuseHumanMessage?: boolean;
        fetchHistory?: boolean;
        ephemeralInstructionMessage?: string;
    }): Promise<void> {
        const {
            message,
            botUserId,
            userContent,
            attachments,
            embeds,
            intent,
            retriesLeft,
            pingUser,
            replyPrefix,
            interactionType,
            interactionAuthorDiscordId,
            thinkingText = "Thinking",
            reuseHumanMessage,
            fetchHistory,
            ephemeralInstructionMessage,
        } = params;

        await Sentry.startSpan(
            {
                name: "Handle Discord message",
                op: "discord.message.handle",
                attributes: {
                    "discord.message_id": message.id,
                    "discord.channel_id": message.channelId,
                    "discord.guild_id": message.guildId ?? DM_GUILD_TOKEN,
                    "discord.attachment_count": attachments?.length ?? 0,
                    "discord.has_reply": message.reference?.messageId !== undefined,
                },
            },
            async (span) => {
                let thinkingMessagePromise: ReturnType<Message["reply"]> | undefined;
                try {
                    // Send the "Thinking" placeholder immediately — fire-and-forget (not awaited)
                    // so it does not delay AI processing. Sent as a reply with allowedMentions
                    // suppressed so the user is not pinged at this stage. The promise is resolved
                    // lazily on the first status update, or awaited when we need to delete it
                    // after the real response is sent.
                    thinkingMessagePromise = message.reply({
                        content: `*${thinkingText} since <t:${Math.round(Date.now() / 1000)}:R>*`,
                        allowedMentions: { repliedUser: false },
                    });

                    const onStatusUpdate: OnStatusUpdate = (update) => {
                        // Await the thinking message promise so we have the message ID before
                        // scheduling an edit. The promise resolves on the first call and is
                        // replaced with a pre-resolved promise for all subsequent status updates.
                        // thinkingMessagePromise is always assigned before onStatusUpdate
                        // can be called — the assignment is on the line above this closure.
                        thinkingMessagePromise = thinkingMessagePromise?.then((thinkingMessage) => {
                            this.statusUpdater.scheduleUpdate(
                                message.channelId,
                                thinkingMessage.id,
                                async (content) =>
                                    void (await thinkingMessage.edit({
                                        content: `*${content} since <t:${Math.round(Date.now() / 1000)}:R>*`,
                                        allowedMentions: {
                                            repliedUser: false,
                                        },
                                    })),
                                agentStatusLabel(update),
                            );
                            return thinkingMessage;
                        });
                    };

                    // Build the application-layer snapshot from the discord.js Message.
                    // previousBotId is not relevant here — isOwnBot detection is only needed
                    // in the live chain fallback path, not for the current user message.
                    const rawSnapshot = buildSnapshot(message, botUserId, undefined);

                    // handle() never throws — errors are caught internally and returned as a response
                    const { response, newMessages, isFailure, isRetryable, usedFallback } =
                        await this.handleDiscordMessageUseCase.execute({
                            discordMessageId: message.id,
                            referencedMessageId: message.reference?.messageId ?? null,
                            channelId: message.channelId,
                            guildId: message.guildId ?? DM_GUILD_TOKEN,
                            discordAuthorId: message.author.id,
                            // Merge stripped content into snapshot; null when reuseHumanMessage is true.
                            snapshot: userContent !== null ? { ...rawSnapshot, content: userContent } : null,
                            attachments: attachments ?? [],
                            // Prefer caller-provided embeds; fall back to those on the snapshot
                            // (rawSnapshot is always built from the same message so they match).
                            embeds: embeds ?? rawSnapshot.embeds,
                            intent,
                            onStatusUpdate,
                            reuseHumanMessage,
                            fetchHistory,
                            ephemeralInstructionMessage,
                        });

                    await this.sendBotReply({
                        replyTarget: message,
                        response,
                        newMessages,
                        isFailure,
                        isRetryable,
                        usedFallback,
                        retriesLeft,
                        thinkingMessagePromise,
                        span,
                        pingUser,
                        replyPrefix,
                        interactionType,
                        interactionAuthorDiscordId,
                    });
                } catch (err) {
                    this.logger.error({ err, discordMessageId: message.id }, "Failed to send or persist bot reply");
                    Sentry.captureException(err);

                    // Attempt to edit the thinking message with an error notice. Guard
                    // against undefined in case the error was thrown before the thinking
                    // message send was initiated. It may also already be deleted if the
                    // error occurred after thinkingMessage.delete(), so swallow any failure.
                    thinkingMessagePromise
                        ?.then(async (thinkingMessage) => {
                            this.statusUpdater.cancel(thinkingMessage.id);
                            const errorReply = await thinkingMessage.edit(
                                "Sorry, I encountered an error processing your request.",
                            );
                            // Persist the error message so it participates in the reply chain.
                            // The thinking message was never saved, so we save it now after the edit.
                            await this.messageRepo.saveAssistantMessage({
                                discordMessageId: errorReply.id,
                                repliesToDiscordId: message.id,
                                channelId: errorReply.channelId,
                                guildId: errorReply.guildId ?? DM_GUILD_TOKEN,
                                discordAuthorId: this.client.user?.id ?? "",
                                newMessages: [],
                                retriesLeft: null,
                                usedFallback: false,
                                interactionType: null,
                                interactionAuthorDiscordId: null,
                            });
                        })
                        .catch((editErr) => {
                            this.logger.warn(
                                { editErr, discordMessageId: message.id },
                                "Failed to edit thinking message with error notice",
                            );
                        });
                }
            },
        );
    }

    /**
     * Extracts grounding source chunks from the last AIMessage in `newMessages` and
     * formats them as a Discord sources line.
     *
     * In Google Search mode, URIs are Google redirect URLs — resolved via HEAD request
     * to unwrap the canonical destination. Any URI not starting with the expected Google
     * redirect prefix is logged as an error (guard against future URL scheme changes).
     *
     * In Tavily mode, URIs are already canonical — no redirect resolution is needed.
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
}
