import type { TextBasedChannel } from "discord.js";
import type { IChatClientChannel } from "../../../application/ports/chat/IChatClientChannel.ts";
import type { IChatClientMessage } from "../../../application/ports/chat/IChatClientMessage.ts";
import { DiscordClientMessage } from "./DiscordClientMessage.ts";

/**
 * Adapts a discord.js `TextBasedChannel` to the `IChatClientChannel` interface.
 *
 * The inner discord.js object is exposed via `discordChannel` as an escape hatch.
 */
export class DiscordClientChannel implements IChatClientChannel {
    constructor(
        /** Escape hatch — direct access to the underlying discord.js TextBasedChannel. */
        public readonly discordChannel: TextBasedChannel,
    ) {}

    async fetchMessage(id: string): Promise<IChatClientMessage> {
        const message = await this.discordChannel.messages.fetch(id);
        return new DiscordClientMessage(message);
    }

    async fetchMessagesAfter(afterId: string, limit: number): Promise<IChatClientMessage[]> {
        const fetched = await this.discordChannel.messages.fetch({ after: afterId, limit });
        return fetched.map((message) => new DiscordClientMessage(message));
    }
}
