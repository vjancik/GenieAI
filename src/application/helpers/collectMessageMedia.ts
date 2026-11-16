import type {
    IChatClientMessage,
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
} from "../ports/chat/IChatClient.ts";

/**
 * Gathers the attachments and embeds whose media belongs in the LLM context for a message.
 *
 * A forwarded message carries nothing of its own: the forwarded content — text,
 * attachments and embeds — sits on its snapshot. Reading only the message's own
 * lists would therefore silently drop every image or video in a forward.
 *
 * The message's own items come first, so an embed's position in the returned list
 * matches its index on the message whenever the message has embeds of its own; for a
 * forward (no own embeds) it matches the index on the snapshot. Media re-fetching
 * relies on that when it resolves an embed token, checking the message first and
 * its snapshots second.
 *
 * @param message - The live chat message
 */
export function collectMessageMedia(message: IChatClientMessage): {
    attachments: IChatClientMessageAttachment[];
    embeds: IChatClientMessageEmbed[];
} {
    const snapshot = message.forwardedSnapshot;
    if (!snapshot) return { attachments: message.attachments, embeds: message.embeds };
    return {
        attachments: [...message.attachments, ...snapshot.attachments],
        embeds: [...message.embeds, ...snapshot.embeds],
    };
}
