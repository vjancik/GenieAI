/**
 * Thin abstraction over the bot's own identity within the chat platform.
 * Replaces direct reads of `client.user?.id` scattered throughout the gateway.
 */
export interface IChatClientBot {
    /** The bot's own user ID on the platform. */
    readonly userId: string;
}
