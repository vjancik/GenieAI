import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, type Message, MessageFlags } from "discord.js";
import type {
    ChatEditOptions,
    ChatReplyOptions,
    IChatClientMessage,
    IChatClientMessageButton,
} from "../../../application/ports/chat/IChatClientMessage.ts";

/** Translates a platform-agnostic button style to the discord.js ButtonStyle enum. */
function toDiscordButtonStyle(style: IChatClientMessageButton["style"]): ButtonStyle {
    return style === "primary" ? ButtonStyle.Primary : ButtonStyle.Secondary;
}

/** Builds a single ActionRow containing all provided buttons. */
function buildButtonRow(buttons: IChatClientMessageButton[]): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b) =>
            new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(toDiscordButtonStyle(b.style)),
        ),
    );
}

/** Parses the buttons on a discord.js Message into platform-agnostic IChatClientMessageButton objects. */
function parseButtons(message: Message): IChatClientMessageButton[] {
    const buttons: IChatClientMessageButton[] = [];
    for (const row of message.components ?? []) {
        if (row.type !== ComponentType.ActionRow) continue;
        for (const component of row.components) {
            if (component.type !== ComponentType.Button) continue;
            if (!component.customId) continue;
            buttons.push({
                customId: component.customId,
                label: component.label ?? "",
                style: component.style === ButtonStyle.Primary ? "primary" : "secondary",
            });
        }
    }
    return buttons;
}

/**
 * Adapts a discord.js `Message` to the `IChatClientMessage` interface.
 *
 * All data accessors are getters that delegate directly to the underlying
 * `Message` — no fields are copied on construction, except `buttons` which
 * is parsed and cached once since component data is stable for the message lifetime.
 * The inner discord.js object is intentionally exposed via `discordMessage` as an
 * escape hatch for the parts of the gateway that still operate directly on discord.js
 * types (buildSnapshot, etc.).
 */
export class DiscordClientMessage implements IChatClientMessage {
    /** Cached — button data is stable for the lifetime of a received message. */
    readonly buttons: IChatClientMessageButton[];

    constructor(
        /** Escape hatch — direct access to the underlying discord.js Message. */
        public readonly discordMessage: Message,
    ) {
        this.buttons = parseButtons(discordMessage);
    }

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
        const { isEphemeral, buttons, ...rest } = options;
        const sent = await this.discordMessage.reply({
            ...rest,
            ...(buttons && buttons.length > 0 && { components: [buildButtonRow(buttons)] }),
            ...(isEphemeral && { flags: MessageFlags.Ephemeral }),
        } as Parameters<Message["reply"]>[0]);
        return new DiscordClientMessage(sent);
    }

    async edit(options: ChatEditOptions): Promise<IChatClientMessage> {
        const { buttons, ...rest } = options;
        const updated = await this.discordMessage.edit({
            ...rest,
            // Pass an empty components array when buttons is explicitly provided but empty,
            // so callers can clear all buttons by passing buttons: [].
            ...(buttons !== undefined && {
                components: buttons.length > 0 ? [buildButtonRow(buttons)] : [],
            }),
        });
        return new DiscordClientMessage(updated);
    }

    async delete(): Promise<void> {
        await this.discordMessage.delete();
    }
}
