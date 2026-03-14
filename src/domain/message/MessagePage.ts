/**
 * Domain entity for a pending "next page" action on a paginated bot response.
 *
 * One row exists per bot message that currently has a Next Page button displayed.
 * The row is deleted immediately after the next page is successfully sent.
 */
export interface MessagePage {
    /** UUIDv7 primary key */
    id: string;
    /** Discord snowflake of the bot message currently showing the Next Page button */
    botDiscordMessageId: string;
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
     * Retrieve the pending page entry for a given bot Discord message ID.
     * @returns The page entry, or null if no pending page exists (e.g. stale button)
     */
    findByBotMessageId(botDiscordMessageId: string): Promise<MessagePage | null>;

    /**
     * Delete a page entry by its primary key.
     * Called after the next page is successfully sent.
     * @param id - The UUIDv7 primary key of the page entry to delete
     */
    delete(id: string): Promise<void>;
}
