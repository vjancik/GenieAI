import type { Client } from "discord.js";
import type { IChatClientBot } from "../../../application/ports/chat/IChatClient.ts";

/**
 * Adapts the discord.js `Client` to the `IChatClientBot` interface.
 *
 * Reads `client.user.id` lazily on each access — the client must be logged in
 * before `userId` is read (same precondition as the previous inline
 * `this.client.user?.id` accesses throughout the gateway).
 */
export class DiscordClientBot implements IChatClientBot {
    constructor(private readonly discordClient: Client) {}

    get userId(): string {
        const id = this.discordClient.user?.id;
        if (!id) throw new Error("Bot user ID is unavailable — client may not be logged in yet.");
        return id;
    }
}
