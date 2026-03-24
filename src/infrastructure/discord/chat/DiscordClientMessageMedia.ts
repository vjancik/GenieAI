import type { Attachment, Embed, MessageSnapshot } from "discord.js";
import type {
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
    IChatClientMessageEmbedField,
    IChatClientMessageEmbedMedia,
    IChatClientMessageSnapshot,
} from "../../../application/ports/chat/IChatClientMessageMedia.ts";

/**
 * Lazy wrapper over a discord.js `Attachment`.
 * All properties are getters that delegate directly to the underlying object.
 */
export class DiscordClientMessageAttachment implements IChatClientMessageAttachment {
    constructor(private readonly attachment: Attachment) {}

    get id(): string {
        return this.attachment.id;
    }

    get url(): string {
        return this.attachment.url;
    }

    get proxyURL(): string {
        return this.attachment.proxyURL;
    }

    get name(): string {
        return this.attachment.name ?? "attachment";
    }

    get size(): number {
        return this.attachment.size;
    }

    get contentType(): string | null {
        return this.attachment.contentType;
    }
}

/**
 * Lazy wrapper over a discord.js `Embed`.
 * All properties are getters that delegate directly to the underlying object.
 * `type` reads `embed.data.type` — discord.js `Embed` has no `.type` getter.
 */
export class DiscordClientMessageEmbed implements IChatClientMessageEmbed {
    constructor(private readonly embed: Embed) {}

    get type(): string {
        return this.embed.data.type ?? "rich";
    }

    get title(): string | null {
        return this.embed.title;
    }

    get description(): string | null {
        return this.embed.description;
    }

    get author(): { name: string } | null {
        return this.embed.author ? { name: this.embed.author.name } : null;
    }

    get provider(): { name: string } | null {
        return this.embed.provider?.name ? { name: this.embed.provider.name } : null;
    }

    get timestamp(): string | null {
        return this.embed.timestamp;
    }

    get footer(): { text: string } | null {
        return this.embed.footer?.text ? { text: this.embed.footer.text } : null;
    }

    get fields(): IChatClientMessageEmbedField[] {
        return this.embed.fields.filter((f) => f.name || f.value);
    }

    get video(): IChatClientMessageEmbedMedia | null {
        const vid = this.embed.video;
        return vid?.url ? { url: vid.url, proxyURL: vid.proxyURL } : null;
    }

    get image(): IChatClientMessageEmbedMedia | null {
        const img = this.embed.image;
        return img?.url ? { url: img.url, proxyURL: img.proxyURL } : null;
    }

    get thumbnail(): IChatClientMessageEmbedMedia | null {
        const thumb = this.embed.thumbnail;
        return thumb?.url ? { url: thumb.url, proxyURL: thumb.proxyURL } : null;
    }
}

/**
 * Lazy wrapper over a discord.js `MessageSnapshot` (forwarded message source).
 * All properties are getters that delegate directly to the underlying object.
 */
export class DiscordClientMessageSnapshot implements IChatClientMessageSnapshot {
    readonly attachments: IChatClientMessageAttachment[];
    readonly embeds: IChatClientMessageEmbed[];

    constructor(
        private readonly snapshot: MessageSnapshot,
        /** The forwarded message's ID — comes from the message reference, not the snapshot itself. */
        readonly id: string,
        /** The channel ID from the message reference — MessageSnapshot does not carry it itself. */
        readonly channelId: string,
    ) {
        this.attachments = [...(snapshot.attachments ?? []).values()].map((a) => new DiscordClientMessageAttachment(a));
        this.embeds = (snapshot.embeds ?? []).map((e) => new DiscordClientMessageEmbed(e));
    }

    get content(): string {
        return this.snapshot.content;
    }

    get cleanContent(): string {
        // MessageSnapshot.cleanContent may be null — fall back to raw content
        return this.snapshot.cleanContent ?? this.snapshot.content;
    }
}
