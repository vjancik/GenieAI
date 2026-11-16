/**
 * Parser for "components" embeds.
 *
 * Some link previews arrive as an embed of type `components`. Such an embed leaves
 * the classic fields (title, description, image, video, thumbnail) empty and carries
 * its text and media in a nested component tree instead — containers, sections,
 * text displays, thumbnails, media galleries and link buttons.
 *
 * discord.js does not model this yet: neither the embed type nor the `components`
 * property is in its typings, although the raw tree is preserved on `embed.data`.
 * The tree is therefore read as untyped JSON and validated with type guards.
 */

import type { APIEmbed } from "discord.js";
import { ComponentType } from "discord.js";

/** A media item found in an embed's component tree. */
export type EmbedComponentMedia = {
    /** Snowflake of the media item; stable across re-fetches of the message. */
    id: string;
    url: string;
    proxyURL: string | null;
    contentType: string | null;
    /** `gallery` items are the embed's content; a `thumbnail` is decoration, e.g. an author avatar. */
    kind: "gallery" | "thumbnail";
};

/** The text and media extracted from an embed's component tree. */
export type ParsedEmbedComponents = {
    /** Text displays and link buttons (as Markdown links), in display order. */
    texts: string[];
    /** All media items, in display order. */
    media: EmbedComponentMedia[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/** Reads the unfurled media object of a thumbnail or gallery item; null when it is malformed. */
function toMedia(media: unknown, kind: EmbedComponentMedia["kind"]): EmbedComponentMedia | null {
    if (!isRecord(media) || typeof media.id !== "string" || typeof media.url !== "string") return null;
    return {
        id: media.id,
        url: media.url,
        proxyURL: stringOrNull(media.proxy_url),
        contentType: stringOrNull(media.content_type),
        kind,
    };
}

/** Depth-first walk that appends a component's own text/media, then descends into its children. */
function visit(node: unknown, out: ParsedEmbedComponents): void {
    if (Array.isArray(node)) {
        for (const child of node) visit(child, out);
        return;
    }
    if (!isRecord(node)) return;

    switch (node.type) {
        case ComponentType.TextDisplay:
            if (typeof node.content === "string" && node.content.trim() !== "") out.texts.push(node.content);
            break;
        case ComponentType.Button:
            // Only link buttons carry a URL; it usually points at the original post
            if (typeof node.url === "string") {
                out.texts.push(`[${stringOrNull(node.label) ?? "Link"}](${node.url})`);
            }
            break;
        case ComponentType.Thumbnail: {
            const media = toMedia(node.media, "thumbnail");
            if (media) out.media.push(media);
            break;
        }
        case ComponentType.MediaGallery:
            if (Array.isArray(node.items)) {
                for (const item of node.items) {
                    const media = isRecord(item) ? toMedia(item.media, "gallery") : null;
                    if (media) out.media.push(media);
                }
            }
            break;
    }

    // Containers, sections and action rows nest children under `components`;
    // a section additionally hangs one thumbnail or button off `accessory`.
    visit(node.components, out);
    visit(node.accessory, out);
}

/**
 * Extracts the text and media of an embed's component tree.
 * Returns empty lists for classic embeds, which have no such tree.
 *
 * @param embed - Raw embed payload, e.g. `Embed.data` from discord.js
 */
export function parseEmbedComponents(embed: APIEmbed): ParsedEmbedComponents {
    const out: ParsedEmbedComponents = { texts: [], media: [] };
    // `components` is absent from APIEmbed's typings, so it narrows to `unknown` here
    visit("components" in embed ? embed.components : null, out);
    return out;
}
