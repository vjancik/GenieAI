import type { IChatClientMessage } from "./IChatClientMessage.ts";

/** Options for an ephemeral follow-up on a button interaction. */
export interface ButtonFollowUpOptions {
    content: string;
    /** Platform-specific flags (e.g. ephemeral). */
    flags?: number;
}

/** Options for an ephemeral reply on a button interaction. */
export interface ButtonReplyOptions {
    content: string;
    /** Platform-specific flags (e.g. ephemeral). */
    flags?: number;
}

/**
 * Thin abstraction over a button interaction, exposing only the operations
 * used by the gateway's button handlers.
 */
export interface IChatClientButtonInteraction {
    /** The message the button is attached to. */
    readonly message: IChatClientMessage;

    /** The custom ID of the button that was clicked. */
    readonly customId: string;

    /** The ID of the user who clicked the button. */
    readonly userId: string;

    /**
     * Acknowledges the button press without sending a visible reply.
     * Must be called within Discord's interaction response window.
     */
    deferUpdate(): Promise<void>;

    /**
     * Sends an ephemeral reply visible only to the user who clicked.
     * Used for early-exit cases before deferUpdate is called.
     */
    reply(options: ButtonReplyOptions): Promise<void>;

    /**
     * Sends an ephemeral follow-up message after deferUpdate has been called.
     */
    followUp(options: ButtonFollowUpOptions): Promise<void>;
}
