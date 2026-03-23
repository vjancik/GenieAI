import type { ButtonInteraction } from "discord.js";
import type {
    ButtonFollowUpOptions,
    ButtonReplyOptions,
    IChatClientButtonInteraction,
} from "../../../application/ports/chat/IChatClientButtonInteraction.ts";
import type { IChatClientMessage } from "../../../application/ports/chat/IChatClientMessage.ts";
import { DiscordClientMessage } from "./DiscordClientMessage.ts";

/**
 * Adapts a discord.js `ButtonInteraction` to the `IChatClientButtonInteraction` interface.
 *
 * The `message` getter wraps the interaction's attached message as an `IChatClientMessage`.
 * The inner discord.js object is exposed via `discordInteraction` as an escape hatch for
 * infrastructure code that still needs direct access (e.g. channel fetching, lock keys).
 */
export class DiscordClientButtonInteraction implements IChatClientButtonInteraction {
    /** Cached wrapper — message identity is stable for the lifetime of this interaction. */
    private readonly _message: IChatClientMessage;

    constructor(
        /** Escape hatch — direct access to the underlying discord.js ButtonInteraction. */
        public readonly discordInteraction: ButtonInteraction,
    ) {
        this._message = new DiscordClientMessage(discordInteraction.message);
    }

    get message(): IChatClientMessage {
        return this._message;
    }

    get customId(): string {
        return this.discordInteraction.customId;
    }

    get userId(): string {
        return this.discordInteraction.user.id;
    }

    async deferUpdate(): Promise<void> {
        await this.discordInteraction.deferUpdate();
    }

    async reply(options: ButtonReplyOptions): Promise<void> {
        // TYPE COERCION: ButtonReplyOptions.flags is a plain number for platform independence;
        // discord.js expects its own MessageFlags enum values, which are numerically identical.
        await this.discordInteraction.reply(options as Parameters<ButtonInteraction["reply"]>[0]);
    }

    async followUp(options: ButtonFollowUpOptions): Promise<void> {
        // TYPE COERCION: Same rationale as reply() — flags are numerically identical to MessageFlags.
        await this.discordInteraction.followUp(options as Parameters<ButtonInteraction["followUp"]>[0]);
    }
}
