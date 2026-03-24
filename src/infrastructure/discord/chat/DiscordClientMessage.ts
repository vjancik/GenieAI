import { type Message, MessageFlags } from "discord.js";
import type {
    ChatEditOptions,
    ChatReplyOptions,
    IChatClientMessage,
} from "../../../application/ports/chat/IChatClientMessage.ts";

/**
 * Adapts a discord.js `Message` to the `IChatClientMessage` interface.
 *
 * All data accessors are getters that delegate directly to the underlying
 * `Message` — no fields are copied on construction. The inner discord.js object
 * is intentionally exposed via `discordMessage` as an escape hatch for the parts
 * of the gateway that still operate directly on discord.js types (button
 * components, buildSnapshot, etc.).
 */
export class DiscordClientMessage implements IChatClientMessage {
    constructor(
        /** Escape hatch — direct access to the underlying discord.js Message. */
        public readonly discordMessage: Message,
    ) {}

    get id(): string {
        return this.discordMessage.id;
    }

    get channelId(): string {
        return this.discordMessage.channelId;
    }

    get guildId(): string | null {
        return this.discordMessage.guildId;
    }

    get authorId(): string {
        return this.discordMessage.author.id;
    }

    get isAuthorBot(): boolean {
        return this.discordMessage.author.bot;
    }

    get content(): string {
        return this.discordMessage.content;
    }

    get cleanContent(): string {
        return this.discordMessage.cleanContent;
    }

    get referencedMessageId(): string | null {
        return this.discordMessage.reference?.messageId ?? null;
    }

    get botRoleId(): string | null {
        return this.discordMessage.guild?.members.me?.roles.botRole?.id ?? null;
    }

    hasExplicitMention(botUserId: string): boolean {
        return this.discordMessage.mentions.has(botUserId, { ignoreRepliedUser: true });
    }

    async reply(options: ChatReplyOptions): Promise<IChatClientMessage> {
        const { isEphemeral, ...rest } = options;
        // TYPE COERCION: components is typed as unknown[] for platform independence;
        // callers in the infrastructure layer pass the actual discord.js component types.
        // flags is coerced because MessageReplyOptions restricts it to non-ephemeral flags,
        // but the interface allows isEphemeral for consistency with other reply surfaces.
        const sent = await this.discordMessage.reply({
            ...rest,
            ...(isEphemeral && { flags: MessageFlags.Ephemeral }),
        } as Parameters<Message["reply"]>[0]);
        return new DiscordClientMessage(sent);
    }

    async edit(options: ChatEditOptions): Promise<IChatClientMessage> {
        // TYPE COERCION: Same rationale as reply() above — components are discord.js types
        // passed through unchanged; the interface uses unknown[] for platform independence.
        const updated = await this.discordMessage.edit(options as Parameters<Message["edit"]>[0]);
        return new DiscordClientMessage(updated);
    }

    async delete(): Promise<void> {
        await this.discordMessage.delete();
    }
}
