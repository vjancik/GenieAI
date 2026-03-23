import type { MessageContextMenuCommandInteraction } from "discord.js";
import type {
    ContextMenuDeferReplyOptions,
    ContextMenuEditReplyOptions,
    ContextMenuReplyOptions,
    IChatClientContextMenuInteraction,
} from "../../../application/ports/chat/IChatClientContextMenuInteraction.ts";
import type { IChatClientMessage } from "../../../application/ports/chat/IChatClientMessage.ts";
import { DiscordClientMessage } from "./DiscordClientMessage.ts";

/**
 * Adapts a discord.js `MessageContextMenuCommandInteraction` to the
 * `IChatClientContextMenuInteraction` interface.
 *
 * The `targetMessage` getter wraps the interaction's target message as an
 * `IChatClientMessage`. The inner discord.js object is exposed via
 * `discordInteraction` as an escape hatch.
 */
export class DiscordClientContextMenuInteraction implements IChatClientContextMenuInteraction {
    /** Cached wrapper — target message identity is stable for the lifetime of this interaction. */
    private readonly _targetMessage: IChatClientMessage;

    constructor(
        /** Escape hatch — direct access to the underlying discord.js interaction. */
        public readonly discordInteraction: MessageContextMenuCommandInteraction,
    ) {
        this._targetMessage = new DiscordClientMessage(discordInteraction.targetMessage);
    }

    get targetMessage(): IChatClientMessage {
        return this._targetMessage;
    }

    get userId(): string {
        return this.discordInteraction.user.id;
    }

    async reply(options: ContextMenuReplyOptions): Promise<void> {
        // TYPE COERCION: flags is a plain number for platform independence;
        // discord.js expects its own MessageFlags enum values, which are numerically identical.
        await this.discordInteraction.reply(options as Parameters<MessageContextMenuCommandInteraction["reply"]>[0]);
    }

    async deferReply(options?: ContextMenuDeferReplyOptions): Promise<void> {
        // TYPE COERCION: Same rationale as reply().
        await this.discordInteraction.deferReply(
            options as Parameters<MessageContextMenuCommandInteraction["deferReply"]>[0],
        );
    }

    async editReply(options: ContextMenuEditReplyOptions): Promise<void> {
        // TYPE COERCION: editReply accepts a superset of our interface options;
        // the files array shape is compatible at runtime.
        await this.discordInteraction.editReply(
            options as Parameters<MessageContextMenuCommandInteraction["editReply"]>[0],
        );
    }

    async deleteReply(): Promise<void> {
        await this.discordInteraction.deleteReply();
    }
}
