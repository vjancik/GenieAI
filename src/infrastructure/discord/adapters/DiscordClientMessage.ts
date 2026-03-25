import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    type Message,
    MessageReferenceType,
} from "discord.js";
import type {
    ChatEditOptions,
    ChatReplyOptions,
    IChatClientMessage,
    IChatClientMessageAttachment,
    IChatClientMessageButton,
    IChatClientMessageEmbed,
} from "../../../application/ports/chat/IChatClient.ts";
import {
    DiscordClientMessageAttachment,
    DiscordClientMessageEmbed,
    DiscordClientMessageSnapshot,
} from "./DiscordClientMessageMedia.ts";

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
    for (const row of message.components) {
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
 * `Message` — no fields are copied on construction, except `buttons`, `attachments`,
 * and `embeds` which are wrapped and cached once since their data is stable for the
 * message lifetime.
 */
export class DiscordClientMessage implements IChatClientMessage {
    /** Cached — button data is stable for the lifetime of a received message. */
    readonly buttons: IChatClientMessageButton[];
    /** Cached — attachment wrappers are stable for the lifetime of a received message. */
    readonly attachments: IChatClientMessageAttachment[];
    /** Cached — embed wrappers are stable for the lifetime of a received message. */
    readonly embeds: IChatClientMessageEmbed[];

    constructor(private readonly discordMessage: Message) {
        this.buttons = parseButtons(discordMessage);
        this.attachments = [...discordMessage.attachments.values()].map((a) => new DiscordClientMessageAttachment(a));
        this.embeds = discordMessage.embeds.map((e) => new DiscordClientMessageEmbed(e));
    }

    get id() {
        return this.discordMessage.id;
    }

    get channelId() {
        return this.discordMessage.channelId;
    }

    get guildId() {
        return this.discordMessage.guildId;
    }

    get authorId() {
        return this.discordMessage.author.id;
    }

    get authorUsername() {
        return this.discordMessage.author.username;
    }

    get authorDisplayName() {
        // Guild-aware display name: nickname > globalName > username (discord.js computed)
        return this.discordMessage.member?.displayName ?? this.discordMessage.author.displayName;
    }

    get isAuthorBot() {
        return this.discordMessage.author.bot;
    }

    get createdAt() {
        return this.discordMessage.createdAt;
    }

    get content() {
        return this.discordMessage.content;
    }

    get cleanContent() {
        return this.discordMessage.cleanContent;
    }

    get referencedMessageId() {
        return this.discordMessage.reference?.messageId ?? null;
    }

    get isForwarded() {
        return this.discordMessage.reference?.type === MessageReferenceType.Forward;
    }

    get forwardedSnapshot() {
        if (!this.isForwarded) return null;
        const refMessageId = this.discordMessage.reference?.messageId;
        const snapshot =
            refMessageId !== undefined ? this.discordMessage.messageSnapshots.get(refMessageId) : undefined;
        if (!snapshot) return null;
        return new DiscordClientMessageSnapshot(snapshot);
    }

    get botRoleId() {
        return this.discordMessage.guild?.members.me?.roles.botRole?.id ?? null;
    }

    hasExplicitMention(botUserId: string) {
        return this.discordMessage.mentions.has(botUserId, { ignoreRepliedUser: true });
    }

    async reply(options: ChatReplyOptions) {
        const { buttons, ...rest } = options;
        const sent = await this.discordMessage.reply({
            ...rest,
            ...(buttons && buttons.length > 0 && { components: [buildButtonRow(buttons)] }),
        });
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

    async delete() {
        void (await this.discordMessage.delete());
    }
}
