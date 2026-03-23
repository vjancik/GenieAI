import type { Client } from "discord.js";
import type { IChatClientBot } from "../../../application/ports/chat/IChatClientBot.ts";

/**
 * Adapts the discord.js `Client` to the `IChatClientBot` interface.
 *
 * Reads `client.user.id` lazily on each access — the client must be logged in
 * before `userId` is read (same precondition as the previous inline
 * `this.client.user?.id` accesses throughout the gateway).
 *
 * The inner discord.js Client is exposed via `discordClient` as an escape hatch
 * for infrastructure code that still needs direct access.
 */
export class DiscordClientBot implements IChatClientBot {
    constructor(
        /** Escape hatch — direct access to the underlying discord.js Client. */
        public readonly discordClient: Client,
    ) {}

    get userId(): string {
        const id = this.discordClient.user?.id;
        if (!id) throw new Error("Bot user ID is unavailable — client may not be logged in yet.");
        return id;
    }
}
