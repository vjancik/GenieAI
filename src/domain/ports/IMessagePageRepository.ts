import type { MessagePage } from "../entities/MessagePage.ts";

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
     * Returns the `firstPageMessageId` for the page state row linked to the given messages row UUID,
     * or `null` if none exists. Fetches only that column — cheaper than loading the full page row.
     *
     * @param messageId - UUID primary key of the messages row showing the Next Page button
     */
    findFirstPageMessageIdByMessageId(
        messageId: MessagePage["messageId"],
    ): Promise<MessagePage["firstPageMessageId"] | null>;
}
