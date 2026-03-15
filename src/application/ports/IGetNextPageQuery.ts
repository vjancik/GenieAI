import type { DiscordMessage } from "../../domain/message/Message.ts";

/**
 * Read model returned by {@link IGetNextPageQuery}.
 *
 * A flat projection combining the fields from `message_pages` needed to compute
 * the next page slice, plus the `langchain_messages` from the first-page messages
 * row needed to reconstruct the full response text.
 *
 * Deliberately not a domain entity — it is a purpose-built query result that
 * crosses two tables and belongs to the query layer, not the repository layer.
 */
export interface NextPageData {
    /** UUID of the message_pages row — used to delete it once the page is delivered. */
    pageStateId: string;
    /**
     * UUID of the first-page messages row.
     * Passed to {@link IMessagePageRepository.save} for subsequent pages so they all
     * point to the same messages row (where the LangChain content lives).
     */
    firstPageMessageId: string;
    /** Character offset in the full response text where the next page begins. */
    endOffset: number;
    /** 1-based page number currently displayed (the page *before* the one being built). */
    currentPage: number;
    /** Total number of pages in this response. */
    totalPages: number;
    /** True when the previous page ended mid-way through a fenced code block. */
    endedInCodeBlock: boolean;
    /** Syntax label of the open code block (e.g. `"typescript"`), or `null`. */
    codeBlockType: string | null;
    /**
     * The serialized LangChain messages from the first-page messages row.
     * The last entry is the final AI response whose text is paginated.
     */
    langchainMessages: DiscordMessage["langchainMessages"];
}

/**
 * Port for the cross-table read query backing {@link GetNextPageUseCase}.
 *
 * Resolves a bot message Discord snowflake (+ guild/channel for uniqueness) to the
 * combined page state + LangChain content needed to compute and deliver the next page.
 *
 * This is intentionally a query object rather than a repository method — it joins
 * across two aggregates (`messages` and `message_pages`) and returns a read model
 * that belongs to neither. See `src/infrastructure/db/queries/` for the implementation.
 */
export interface IGetNextPageQuery {
    /**
     * @param lookup.discordMessageId - Discord snowflake of the bot message showing the Next Page button
     * @param lookup.channelId - Discord channel snowflake
     * @param lookup.guildId - Discord guild snowflake, or `"@me"` for DMs
     * @returns The combined read model, or `null` if no pending page state exists (stale button)
     */
    execute(lookup: { discordMessageId: string; channelId: string; guildId: string }): Promise<NextPageData | null>;
}
