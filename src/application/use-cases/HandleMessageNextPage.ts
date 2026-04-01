import * as Sentry from "@sentry/bun";
import type { IMessagePageRepository } from "../../domain/ports/IMessagePageRepository.ts";
import type { IMessageRepository } from "../../domain/ports/IMessageRepository.ts";
import { splitMarkdown } from "../formatters/markdownSplitter.ts";
import { llmTextToDiscordText } from "../formatters/textTransformers.ts";
import { extractContent } from "../helpers/messageTransformers.ts";
import type {
    IChatClientBot,
    IChatClientButtonInteraction,
    IChatClientMessageButton,
} from "../ports/chat/IChatClient.ts";
import type { IGetNextPageQuery } from "../ports/IGetNextPageQuery.ts";
import type { IInteractionLock } from "../ports/IInteractionLock.ts";
import { DM_GUILD_TOKEN, NEXT_PAGE_BUTTON_ID } from "../shared/tokens.ts";
import type { Logger } from "../types/Logger.ts";

/** Discord's maximum message length in characters. */
const MESSAGE_LENGTH_LIMIT = 2000;

/**
 * Returns the button array for `message` with the button matching `removeId` filtered out.
 * Preserves all other buttons so removing the Next Page button leaves any co-located
 * buttons intact. Passing the result to `message.edit({ buttons })` replaces the row in-place.
 */
function withoutButton(
    message: IChatClientButtonInteraction["message"],
    removeId: string,
): IChatClientButtonInteraction["message"]["buttons"] {
    return message.buttons.filter((b) => b.customId !== removeId);
}

/** Result of a successful page computation. */
export interface GetNextPageResult {
    /** Next page content (ready to send to Discord — no footer appended). */
    content: string;
    /** Character offset in the full text where the page after this one begins. */
    newOffset: number;
    /** 1-based page number of the page returned. */
    currentPage: number;
    /** Total number of pages in this response. */
    totalPages: number;
    /** True when this is the final page (no more Next Page button needed). */
    isLast: boolean;
    /** Primary key of the message_pages row that was looked up. */
    pageStateId: string;
    /**
     * UUID primary key of the first page bot message row in the messages table.
     * Must be passed to {@link IMessagePageRepository.save} for subsequent pages so they
     * all reference the first page's messages row (where the LangChain content lives).
     */
    firstPageMessageId: string;
    /** True when this page ended mid-way through a fenced code block. */
    endedInCodeBlock: boolean;
    /**
     * Syntax label of the open code block at the boundary (e.g. `"typescript"`), or an
     * empty string for an unlabelled block. `null` when `endedInCodeBlock` is false.
     */
    codeBlockType: string | null;
}

/**
 * Application use case: handles a Next Page button click on a paginated bot response.
 *
 * Owns the full flow: lock check, deferred update, page fetch (DB query + page slice
 * computation), reply send, DB persist, and button removal.
 */
export class HandleNextPageUseCase {
    /**
     * @param getNextPageQuery - Query object for fetching page state from the DB
     * @param messageRepo - Repository for persisting the new bot message row
     * @param messagePageRepo - Repository for persisting the next page state row
     * @param bot - Chat client bot adapter for reading the current bot user ID
     * @param logger - Logger instance
     * @param interactionLock - Lock to prevent duplicate concurrent button processing
     */
    constructor(
        private readonly getNextPageQuery: IGetNextPageQuery,
        private readonly messageRepo: IMessageRepository,
        private readonly messagePageRepo: IMessagePageRepository,
        private readonly bot: IChatClientBot,
        private readonly logger: Logger,
        private readonly interactionLock: IInteractionLock,
    ) {}

    /**
     * Executes the Next Page flow for a button interaction.
     *
     * Retrieves the pending page state from the DB, sends the next page as a Discord
     * reply to the current bot message, updates the DB state, and removes the button
     * from the old message.
     *
     * If the page state is missing (stale button) or an error occurs, removes the
     * button and returns. The interaction lock prevents duplicate concurrent processing.
     */
    async execute(interaction: IChatClientButtonInteraction): Promise<void> {
        if (this.interactionLock.isLocked(interaction.message.id, interaction.customId)) {
            await interaction.deferUpdate();
            return;
        }
        this.interactionLock.setLocked(interaction.message.id, interaction.customId);
        try {
            // Acknowledge immediately to prevent Discord's "interaction failed" timeout
            await interaction.deferUpdate();

            const currentBotMessageId = interaction.message.id;

            this.logger.info(
                {
                    botMessageId: currentBotMessageId,
                    channelId: interaction.message.channelId,
                    guildId: interaction.message.guildId,
                    invokerUserId: interaction.userId,
                },
                "Handling Next Page button",
            );

            await Sentry.startSpan(
                {
                    name: "Handle Next Page button",
                    op: "chat.interaction.next_page",
                    attributes: {
                        // NOTE: pass in to use case when extending
                        "chat.platform": "Discord",
                        "chat.command.type": "Button",
                        "chat.message_id": currentBotMessageId,
                    },
                },
                async (span) => {
                    // Step 1: Compute next page content
                    let result: GetNextPageResult | null;
                    try {
                        result = await this.computeNextPage(
                            currentBotMessageId,
                            interaction.message.channelId,
                            interaction.message.guildId ?? DM_GUILD_TOKEN,
                        );
                    } catch (err) {
                        this.logger.error({ err, currentBotMessageId }, "Failed to compute next page");
                        Sentry.captureException(err);
                        await interaction.message
                            .edit({ buttons: withoutButton(interaction.message, NEXT_PAGE_BUTTON_ID) })
                            .catch(() => {});
                        return;
                    }

                    if (!result) {
                        // No pending page state — stale button click
                        await interaction.message
                            .edit({ buttons: withoutButton(interaction.message, NEXT_PAGE_BUTTON_ID) })
                            .catch((err) => {
                                this.logger.warn(
                                    { err, currentBotMessageId },
                                    "Failed to remove stale Next Page button",
                                );
                            });
                        return;
                    }

                    span.setAttributes({
                        "chat.page": result.currentPage,
                        "chat.total_pages": result.totalPages,
                        "chat.is_last_page": result.isLast,
                    });

                    // Step 2: Build buttons for next message (omit on last page)
                    const nextPageButton: IChatClientMessageButton | undefined = result.isLast
                        ? undefined
                        : {
                              customId: NEXT_PAGE_BUTTON_ID,
                              label: `Next Page · Page ${result.currentPage} of ${result.totalPages}`,
                              style: "primary",
                          };

                    // Step 3: Send the next page as a reply to the current bot message
                    let newBotMessage: IChatClientButtonInteraction["message"];
                    try {
                        newBotMessage = await interaction.message.reply({
                            content: result.content,
                            ...(nextPageButton && { buttons: [nextPageButton] }),
                        });
                    } catch (err) {
                        this.logger.error({ err, currentBotMessageId }, "Failed to send next page reply");
                        Sentry.captureException(err);
                        return;
                    }

                    // Step 4: Persist the messages row first — messagePageRepo.save has a FK on it,
                    // so if this throws the remaining cleanup is skipped entirely.
                    const savedNextBotMsg = await this.messageRepo.saveBotMessage({
                        discordMessageId: newBotMessage.id,
                        repliesToDiscordId: currentBotMessageId,
                        channelId: newBotMessage.channelId,
                        guildId: newBotMessage.guildId ?? DM_GUILD_TOKEN,
                        discordAuthorId: this.bot.userId,
                        langchainMessages: [],
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
                            .edit({ buttons: withoutButton(interaction.message, NEXT_PAGE_BUTTON_ID) })
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
     * Fetches the pending page state from the DB and computes the next page slice.
     * Returns null when no pending page state exists (stale button).
     */
    private async computeNextPage(
        discordMessageId: string,
        channelId: string,
        guildId: string,
    ): Promise<GetNextPageResult | null> {
        const data = await this.getNextPageQuery.execute({ discordMessageId, channelId, guildId });
        if (!data) {
            this.logger.debug({ discordMessageId }, "No pending page state found — stale button click");
            return null;
        }

        const lastMsgJson = data.langchainMessages.at(-1);
        if (!lastMsgJson) {
            this.logger.warn({ discordMessageId }, "langchainMessages array is empty for bot message");
            return null;
        }

        // TYPE COERCION: lastMsgJson.kwargs.content is unknown; LangChain serialization always stores
        // content as string | unknown[] in kwargs, matching the extractContent parameter type.
        const kwargs = lastMsgJson.kwargs as Record<string, unknown> | undefined;
        const rawText = extractContent(kwargs?.content as string | unknown[]);
        const fullDiscordText = llmTextToDiscordText(rawText);

        const { currentPage, totalPages, endOffset, endedInCodeBlock, codeBlockType } = data;
        const nextPage = currentPage + 1;
        const isLast = nextPage >= totalPages;

        const continuationCodeBlock = endedInCodeBlock ? (codeBlockType ?? "") : null;
        const {
            content,
            newOffset,
            endedInCodeBlock: nextEndedInCodeBlock,
            codeBlockType: nextCodeBlockType,
        } = splitMarkdown(fullDiscordText, endOffset, MESSAGE_LENGTH_LIMIT, { continuationCodeBlock });

        this.logger.debug({ discordMessageId, page: nextPage, totalPages, isLast }, "Computed next page content");

        return {
            content,
            newOffset,
            currentPage: nextPage,
            totalPages,
            isLast,
            pageStateId: data.pageStateId,
            firstPageMessageId: data.firstPageMessageId,
            endedInCodeBlock: nextEndedInCodeBlock,
            codeBlockType: nextCodeBlockType,
        };
    }
}
