import { ChannelType, GuildChannel, type MessageContextMenuCommandInteraction, MessageFlags } from "discord.js";
import type {
    ContextMenuDeferReplyOptions,
    ContextMenuEditReplyOptions,
    ContextMenuReplyOptions,
    IChatClientContextMenuInteraction,
    IChatClientMessage,
} from "../../../application/ports/chat/IChatClient.ts";
import { DiscordClientMessage } from "./DiscordClientMessage.ts";

/**
 * Adapts a discord.js `MessageContextMenuCommandInteraction` to the
 * `IChatClientContextMenuInteraction` interface.
 *
 * The `targetMessage` getter wraps the interaction's target message as an
 * `IChatClientMessage`.
 */
export class DiscordClientContextMenuInteraction implements IChatClientContextMenuInteraction {
    /** Cached wrapper — target message identity is stable for the lifetime of this interaction. */
    private readonly _targetMessage: IChatClientMessage;

    constructor(private readonly discordInteraction: MessageContextMenuCommandInteraction) {
        this._targetMessage = new DiscordClientMessage(discordInteraction.targetMessage);
    }

    get targetMessage() {
        return this._targetMessage;
    }

    get userId() {
        return this.discordInteraction.user.id;
    }

    get isDM() {
        return this.discordInteraction.channel?.type === ChannelType.DM;
    }

    get canSendMessageInTargetChannel() {
        // DMs are always writable by the bot
        if (this.isDM) return true;
        const channel = this.discordInteraction.channel;
        const me = this.discordInteraction.guild?.members.me;
        if (!channel || !me || !(channel instanceof GuildChannel)) return false;
        return channel.permissionsFor(me)?.has(["ViewChannel", "SendMessages"]) ?? false;
    }

    async reply(options: ContextMenuReplyOptions) {
        void (await this.discordInteraction.reply({
            content: options.content,
            ...(options.isEphemeral && { flags: MessageFlags.Ephemeral }),
        }));
    }

    async deferReply(options?: ContextMenuDeferReplyOptions) {
        void (await this.discordInteraction.deferReply({
            ...(options?.isEphemeral && { flags: MessageFlags.Ephemeral }),
        }));
    }

    async editReply(options: ContextMenuEditReplyOptions) {
        // TYPE COERCION: editReply accepts a superset of our interface options;
        // the files array shape is compatible at runtime.
        void (await this.discordInteraction.editReply(
            options as Parameters<MessageContextMenuCommandInteraction["editReply"]>[0],
        ));
    }

    async deleteReply() {
        void (await this.discordInteraction.deleteReply());
    }
}
