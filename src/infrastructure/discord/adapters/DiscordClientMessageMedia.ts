import type { Attachment, Embed, MessageSnapshot } from "discord.js";
import type {
    IChatClientMessageAttachment,
    IChatClientMessageEmbed,
    IChatClientMessageEmbedField,
    IChatClientMessageEmbedMedia,
    IChatClientMessageSnapshot,
} from "../../../application/ports/chat/IChatClient.ts";

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

/** Wraps a discord.js embed media object (video/image/thumbnail). */
class DiscordClientMessageEmbedMedia implements IChatClientMessageEmbedMedia {
    constructor(private readonly media: { url: string; proxyURL?: string | null }) {}

    get url(): string {
        return this.media.url;
    }

    get proxyURL(): string | null {
        return this.media.proxyURL ?? null;
    }
}

/**
 * Lazy wrapper over a discord.js `Embed`.
 * Single-property sub-objects are flattened to scalar getters.
 * Multi-property media sub-objects are wrapped and cached on construction.
 * `type` reads `embed.data.type` — discord.js `Embed` has no `.type` getter.
 */
export class DiscordClientMessageEmbed implements IChatClientMessageEmbed {
    readonly video: IChatClientMessageEmbedMedia | null;
    readonly image: IChatClientMessageEmbedMedia | null;
    readonly thumbnail: IChatClientMessageEmbedMedia | null;

    constructor(private readonly embed: Embed) {
        this.video = embed.video?.url ? new DiscordClientMessageEmbedMedia(embed.video) : null;
        this.image = embed.image?.url ? new DiscordClientMessageEmbedMedia(embed.image) : null;
        this.thumbnail = embed.thumbnail?.url ? new DiscordClientMessageEmbedMedia(embed.thumbnail) : null;
    }

    get type() {
        return this.embed.data.type ?? null;
    }

    get title() {
        return this.embed.title;
    }

    get description() {
        return this.embed.description;
    }

    get authorName() {
        return this.embed.author?.name ?? null;
    }

    get providerName() {
        return this.embed.provider?.name ?? null;
    }

    get timestamp() {
        return this.embed.timestamp;
    }

    get footerText() {
        return this.embed.footer?.text ?? null;
    }

    get fields(): IChatClientMessageEmbedField[] {
        return this.embed.fields;
    }
}

/** Wraps a discord.js `MessageSnapshot` exposing only the content needed for LLM formatting and attachment upload. */
export class DiscordClientMessageSnapshot implements IChatClientMessageSnapshot {
    readonly attachments: IChatClientMessageAttachment[];
    readonly embeds: IChatClientMessageEmbed[];

    constructor(private readonly snapshot: MessageSnapshot) {
        this.attachments = [...snapshot.attachments.values()].map((a) => new DiscordClientMessageAttachment(a));
        this.embeds = snapshot.embeds.map((e) => new DiscordClientMessageEmbed(e));
    }

    get cleanContent() {
        return this.snapshot.cleanContent;
    }

    get content(): string {
        return this.snapshot.content;
    }
}
