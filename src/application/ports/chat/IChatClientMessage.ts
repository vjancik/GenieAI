/**
 * Thin abstraction over a chat platform message, exposing only the operations
 * used by the application layer. Concrete implementations adapt platform-specific
 * objects (e.g. discord.js `Message`) without copying their fields.
 *
 * Data accessors are declared as readonly properties so that class getter
 * implementations satisfy them without any data copying on construction.
 * Callables that take parameters remain methods.
 */

/** Options for replying to a message. */
export interface ChatReplyOptions {
    content?: string;
    components?: unknown[];
    files?: ChatFileAttachment[];
    allowedMentions?: {
        repliedUser: boolean;
        users?: string[];
    };
    isEphemeral?: boolean;
}

/** Options for editing a message in-place. */
export interface ChatEditOptions {
    content?: string;
    components?: unknown[];
}

/** A file to attach when replying. */
export interface ChatFileAttachment {
    attachment: Buffer;
    name: string;
}

export interface IChatClientMessage {
    /** Platform snowflake / unique message ID. */
    readonly id: string;

    /** ID of the channel this message was sent in. */
    readonly channelId: string;

    /**
     * ID of the guild (server) this message was sent in.
     * `null` for direct messages.
     */
    readonly guildId: string | null;

    /** ID of the user who authored this message. */
    readonly authorId: string;

    /** Whether the author is a bot account. */
    readonly isAuthorBot: boolean;

    /** Raw text content of the message. */
    readonly content: string;

    /**
     * Message content with mention snowflakes resolved to human-readable display names.
     * On platforms without mention syntax this may equal `content`.
     */
    readonly cleanContent: string;

    /**
     * The ID of the message this message is replying to, if any.
     * `null` when not a reply.
     */
    readonly referencedMessageId: string | null;

    /**
     * The bot's managed role ID in the guild this message belongs to.
     * `null` for DMs where no guild role exists.
     *
     * Used to strip the bot's role mention from message content.
     */
    readonly botRoleId: string | null;

    /**
     * Returns true when the bot was explicitly @mentioned in this message
     * (i.e. the user typed `@BotName`), as opposed to Discord auto-including
     * a mention because this message is a reply to the bot.
     *
     * @param botUserId - The bot's Discord user ID
     */
    hasExplicitMention(botUserId: string): boolean;

    /**
     * Send a reply to this message.
     * Returns the sent reply as an `IChatClientMessage`.
     */
    reply(options: ChatReplyOptions): Promise<IChatClientMessage>;

    /**
     * Edit this message in-place.
     * Returns the updated message as an `IChatClientMessage`.
     */
    edit(options: ChatEditOptions): Promise<IChatClientMessage>;

    /** Delete this message. */
    delete(): Promise<void>;
}
