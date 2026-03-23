import type { IChatClientMessage } from "./IChatClientMessage.ts";

/** A file attachment for an interaction reply. */
export interface InteractionFileAttachment {
    attachment: Buffer;
    name: string;
}

/** Options for an ephemeral reply on a context menu interaction. */
export interface ContextMenuReplyOptions {
    content: string;
    /** Platform-specific flags (e.g. ephemeral). */
    flags?: number;
}

/** Options for deferring a context menu interaction reply. */
export interface ContextMenuDeferReplyOptions {
    /** Platform-specific flags (e.g. ephemeral). */
    flags?: number;
}

/** Options for editing a deferred context menu reply. */
export interface ContextMenuEditReplyOptions {
    files: InteractionFileAttachment[];
}

/**
 * Thin abstraction over a message context menu interaction, exposing only
 * the operations used by the gateway's context menu handlers.
 */
export interface IChatClientContextMenuInteraction {
    /** The message the context menu was invoked on. */
    readonly targetMessage: IChatClientMessage;

    /** The ID of the user who invoked the context menu. */
    readonly userId: string;

    /** Sends an ephemeral reply (used for early-exit cases or ACK messages). */
    reply(options: ContextMenuReplyOptions): Promise<void>;

    /**
     * Acknowledges the interaction and defers the reply.
     * The reply must be completed with editReply().
     */
    deferReply(options?: ContextMenuDeferReplyOptions): Promise<void>;

    /** Edits the deferred reply, e.g. to attach a rendered file. */
    editReply(options: ContextMenuEditReplyOptions): Promise<void>;

    /** Deletes the ephemeral reply sent via reply(). */
    deleteReply(): Promise<void>;
}
