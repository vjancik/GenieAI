import type { IChatClientMessage } from "./IChatClientMessage.ts";

/**
 * Thin abstraction over a chat platform channel, exposing only the message-fetch
 * operations used by the application layer. Concrete implementations adapt
 * platform-specific channel objects (e.g. discord.js `TextBasedChannel`).
 */
export interface IChatClientChannel {
    /**
     * Fetches a single message by ID.
     * Propagates the underlying platform error if the message cannot be retrieved
     * (e.g. deleted, no permissions). Callers are responsible for error handling.
     */
    fetchMessage(id: string): Promise<IChatClientMessage>;

    /**
     * Fetches up to `limit` messages sent after the message with `afterId`.
     * Propagates the underlying platform error on failure.
     */
    fetchMessagesAfter(afterId: string, limit: number): Promise<IChatClientMessage[]>;
}
