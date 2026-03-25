import { type ButtonInteraction, MessageFlags } from "discord.js";
import type {
    ButtonFollowUpOptions,
    ButtonReplyOptions,
    IChatClientButtonInteraction,
    IChatClientChannel,
    IChatClientMessage,
} from "../../../application/ports/chat/IChatClient.ts";
import { DiscordClientChannel } from "./DiscordClientChannel.ts";
import { DiscordClientMessage } from "./DiscordClientMessage.ts";

/**
 * Adapts a discord.js `ButtonInteraction` to the `IChatClientButtonInteraction` interface.
 *
 * The `message` and `channel` getters wrap the interaction's attached objects as
 * platform-agnostic interfaces, cached on construction.
 */
export class DiscordClientButtonInteraction implements IChatClientButtonInteraction {
    /** Cached wrapper — message identity is stable for the lifetime of this interaction. */
    private readonly _message: IChatClientMessage;
    /** Cached wrapper — channel identity is stable for the lifetime of this interaction. */
    private readonly _channel: IChatClientChannel | null;

    constructor(private readonly discordInteraction: ButtonInteraction) {
        this._message = new DiscordClientMessage(discordInteraction.message);
        this._channel = discordInteraction.channel ? new DiscordClientChannel(discordInteraction.channel) : null;
    }

    get message() {
        return this._message;
    }

    get channel() {
        return this._channel;
    }

    get customId() {
        return this.discordInteraction.customId;
    }

    get userId() {
        return this.discordInteraction.user.id;
    }

    async deferUpdate() {
        void (await this.discordInteraction.deferUpdate());
    }

    async reply(options: ButtonReplyOptions) {
        void (await this.discordInteraction.reply({
            content: options.content,
            ...(options.isEphemeral && { flags: MessageFlags.Ephemeral }),
        }));
    }

    async followUp(options: ButtonFollowUpOptions) {
        void (await this.discordInteraction.followUp({
            content: options.content,
            ...(options.isEphemeral && { flags: MessageFlags.Ephemeral }),
        }));
    }
}
