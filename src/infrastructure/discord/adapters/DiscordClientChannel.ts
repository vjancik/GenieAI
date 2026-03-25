import type { TextBasedChannel } from "discord.js";
import type { IChatClientChannel, IChatClientMessage } from "../../../application/ports/chat/IChatClient.ts";
import { DiscordClientMessage } from "./DiscordClientMessage.ts";

/**
 * Adapts a discord.js `TextBasedChannel` to the `IChatClientChannel` interface.
 *
 */
export class DiscordClientChannel implements IChatClientChannel {
    constructor(private readonly discordChannel: TextBasedChannel) {}

    async fetchMessage(id: string): Promise<IChatClientMessage> {
        const message = await this.discordChannel.messages.fetch(id);
        return new DiscordClientMessage(message);
    }

    async fetchMessagesAfter(afterId: string, limit: number): Promise<IChatClientMessage[]> {
        const fetched = await this.discordChannel.messages.fetch({ after: afterId, limit });
        return fetched.map((message) => new DiscordClientMessage(message));
    }
}
