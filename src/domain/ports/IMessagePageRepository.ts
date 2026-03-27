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
}
