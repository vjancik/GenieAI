/**
 * Domain entity for a pending "next page" action on a paginated bot response.
 *
 * One row exists per page that has been sent with a Next Page button displayed.
 * All rows for the same paginated response share the same firstPageDiscordMessageId,
 * which points to the messages row holding the LangChain content.
 */
export interface MessagePage {
    /** UUIDv7 primary key */
    id: string;
    /**
     * Discord snowflake of the bot message currently showing the Next Page button.
     * Unique — used to look up the pending page state when the button is clicked.
     */
    botDiscordMessageId: string;
    /**
     * Discord snowflake of the FIRST page bot message for this paginated response.
     * All page rows for a response share this ID — the LangChain content lives on
     * the first page's messages row and must be referenced for all subsequent pages.
     */
    firstPageDiscordMessageId: string;
    /** Character offset in the full transformed response text where the next page begins */
    endOffset: number;
    /** 1-based page number currently displayed to the user */
    currentPage: number;
    /** Total number of pages in this response */
    totalPages: number;
    createdAt: Date;
}

/**
 * Port for persisting and retrieving pending message page state.
 *
 * Implementations are responsible for transient storage of pagination state
 * between the initial paginated send and the user clicking the Next Page button.
 */
export interface IMessagePageRepository {
    /**
     * Persist a new pending page entry.
     * @param page - All fields except auto-generated id and createdAt
     * @returns The saved page including generated id and createdAt
     */
    save(page: Omit<MessagePage, "id" | "createdAt">): Promise<MessagePage>;

    /**
     * Retrieve the pending page entry for the bot message currently showing the Next Page button.
     * @returns The page entry, or null if no pending page exists (e.g. stale button)
     */
    findByBotMessageId(botDiscordMessageId: string): Promise<MessagePage | null>;
}
