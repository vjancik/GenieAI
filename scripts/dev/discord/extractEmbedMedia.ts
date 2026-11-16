/**
 * Extracts the embed media URLs (video / image / thumbnail) of a Discord message.
 *
 * Reads the message over the REST API, so no gateway connection is opened. Embeds
 * of forwarded messages (message snapshots) are included as well.
 *
 * Usage: bun scripts/dev/discord/extractEmbedMedia.ts <message link> [--json]
 *
 * Requires DISCORD_TOKEN (loaded automatically from .env by Bun). The bot must be
 * able to read the channel.
 */

import type { APIEmbed, APIMessage } from "discord.js";
import { REST, Routes } from "discord.js";

const EMBED_MEDIA_KEYS = ["video", "image", "thumbnail"] as const;

/** One media item found on an embed. */
export type EmbedMedia = {
    /** Where the embed lives: the message itself or a forwarded snapshot. */
    source: string;
    embedIndex: number;
    embedType: string | null;
    /**
     * Classic embeds expose media under a fixed key. "components" embeds (type `components`)
     * nest media inside a component tree instead; those are classified by their content type.
     */
    origin: "embed-field" | "embed-component";
    mediaKey: (typeof EMBED_MEDIA_KEYS)[number];
    url: string | null;
    proxyUrl: string | null;
    contentType: string | null;
    width: number | null;
    height: number | null;
};

/** Parses `https://discord.com/channels/<guild>/<channel>/<message>` into its IDs. */
function parseMessageLink(link: string): { channelId: string; messageId: string } {
    const match = /\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/.exec(link);
    const [, channelId, messageId] = match ?? [];
    if (channelId === undefined || messageId === undefined) {
        throw new Error(`Not a Discord message link: ${link}`);
    }
    return { channelId, messageId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

/**
 * Recursively collects the `media` objects of a component tree.
 *
 * Link-preview embeds of type `components` carry no `video` / `image` / `thumbnail` fields;
 * their media sits on thumbnail accessories and media-gallery items nested inside containers
 * and sections. The tree is walked generically because discord.js does not type it yet.
 */
function collectComponentMedia(
    node: unknown,
    base: Pick<EmbedMedia, "source" | "embedIndex" | "embedType">,
): EmbedMedia[] {
    if (Array.isArray(node)) return node.flatMap((child) => collectComponentMedia(child, base));
    if (!isRecord(node)) return [];

    const found: EmbedMedia[] = [];
    const media = node.media;
    if (isRecord(media) && typeof media.url === "string") {
        const contentType = stringOrNull(media.content_type);
        found.push({
            ...base,
            origin: "embed-component",
            mediaKey: contentType?.startsWith("video/") ? "video" : "image",
            url: media.url,
            proxyUrl: stringOrNull(media.proxy_url),
            contentType,
            width: numberOrNull(media.width),
            height: numberOrNull(media.height),
        });
    }
    // Children live under different keys depending on the component type
    for (const key of ["components", "items", "accessory"]) {
        found.push(...collectComponentMedia(node[key], base));
    }
    return found;
}

/** Flattens the media items of a list of embeds. */
function collectEmbedMedia(embeds: APIEmbed[], source: string): EmbedMedia[] {
    return embeds.flatMap((embed, embedIndex) => [
        ...collectEmbedFieldMedia(embed, embedIndex, source),
        ...collectComponentMedia("components" in embed ? embed.components : null, {
            source,
            embedIndex,
            embedType: embed.type ?? null,
        }),
    ]);
}

/** Collects the media under the classic `video` / `image` / `thumbnail` embed fields. */
function collectEmbedFieldMedia(embed: APIEmbed, embedIndex: number, source: string): EmbedMedia[] {
    return EMBED_MEDIA_KEYS.flatMap((mediaKey) => {
        const media = embed[mediaKey];
        if (!media) return [];
        return [
            {
                source,
                embedIndex,
                embedType: embed.type ?? null,
                origin: "embed-field",
                mediaKey,
                url: media.url ?? null,
                proxyUrl: media.proxy_url ?? null,
                // content_type is sent by Discord for some embeds but is missing from the typings
                contentType:
                    "content_type" in media && typeof media.content_type === "string" ? media.content_type : null,
                width: media.width ?? null,
                height: media.height ?? null,
            },
        ];
    });
}

/**
 * Fetches a message by its link and returns every embed media item on it.
 *
 * @param messageLink - A `https://discord.com/channels/...` message link
 * @param token - Discord bot token
 */
export async function extractEmbedMedia(messageLink: string, token: string): Promise<EmbedMedia[]> {
    const { channelId, messageId } = parseMessageLink(messageLink);
    const rest = new REST().setToken(token);
    // TYPE COERCION: REST.get() returns unknown; this route is documented to return a message object
    const message = (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;

    const snapshots = message.message_snapshots ?? [];
    return [
        ...collectEmbedMedia(message.embeds, "message"),
        ...snapshots.flatMap((snapshot, index) => collectEmbedMedia(snapshot.message.embeds, `snapshot-${index}`)),
    ];
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const link = args.find((arg) => !arg.startsWith("--"));
    const token = process.env.DISCORD_TOKEN;
    if (link === undefined) {
        console.error("Usage: bun scripts/dev/discord/extractEmbedMedia.ts <message link> [--json]");
        process.exit(1);
    }
    if (!token) throw new Error("DISCORD_TOKEN env var is required");

    const media = await extractEmbedMedia(link, token);
    if (args.includes("--json")) {
        console.log(JSON.stringify(media, null, 2));
    } else if (media.length === 0) {
        console.log("No embed media found on this message.");
    } else {
        for (const item of media) {
            console.log(
                `${item.source} embed[${item.embedIndex}] (${item.embedType ?? "?"}, ${item.origin}) ${item.mediaKey}`,
            );
            console.log(`  url:         ${item.url ?? "-"}`);
            console.log(`  proxyUrl:    ${item.proxyUrl ?? "-"}`);
            console.log(`  contentType: ${item.contentType ?? "-"}  size: ${item.width ?? "?"}x${item.height ?? "?"}`);
        }
    }
}
