/**
 * Text transformation utilities at the application layer boundary.
 *
 * `llmTextToDiscordText` — sanitizes LLM output for Discord rendering
 * `discordMessageToLlmText` — enriches a Discord message with sender context for LLM input
 */

import type { IChatClientMessage } from "../ports/chat/IChatClientMessage.ts";
import type { IChatClientMessageEmbed, IChatClientMessageSnapshot } from "../ports/chat/IChatClientMessageMedia.ts";

/**
 * Regex that matches one or more blank-ish lines — any sequence of lines that
 * contain only optional horizontal whitespace (spaces/tabs), collapsed into a
 * single newline.  The `\r` handles Windows-style CRLF.
 *
 * Specifically matches: a newline, then one or more lines that are all
 * horizontal whitespace optionally followed by another newline.
 */
const MULTI_BLANK_LINE_RE = /(\r?\n)([ \t]*\r?\n)+/g;

/**
 * Regex that matches bare http/https URLs not already wrapped in `<…>`.
 *
 * Negative look-behind `(?<!<)` ensures we don't double-wrap URLs that are
 * already suppressed.  The URL body stops at the first whitespace or `>`.
 */
const BARE_URL_RE = /(?<!<)(https?:\/\/[^\s>]+)/g;

/**
 * Regex that matches a Markdown horizontal rule on its own line.
 *
 * Discord does not render `---`, `***`, or `___` as horizontal rules, so we
 * strip them to avoid visual clutter.  The pattern requires:
 * - Start of string or a preceding newline
 * - Optional leading horizontal whitespace
 * - Three or more of the same rule character (`-`, `*`, or `_`)
 * - Optional trailing horizontal whitespace
 * - End of string or a following newline
 *
 * The `m` flag makes `^`/`$` match per line.
 */
const HORIZONTAL_RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm;

/**
 * Prepares LLM-generated text for display in Discord by removing formatting
 * constructs that Discord does not render or that produce excessive whitespace.
 *
 * Transformations applied (in order):
 * 1. Strip Markdown horizontal rules (`---`, `***`, `___` on their own line)
 * 2. Collapse multiple consecutive blank lines into a single newline
 * 3. Trim leading and trailing whitespace
 *
 * @param text - Raw LLM response text
 */
export function llmTextToDiscordText(text: string): string {
    return text.replace(HORIZONTAL_RULE_RE, "").replace(MULTI_BLANK_LINE_RE, "\n").replace(BARE_URL_RE, "<$1>").trim();
}

/** Formats a Date verbosely in UTC, e.g. "Monday, March 17, 2024 at 02:35:00 PM UTC". */
export function formatUtcTimestamp(d: Date): string {
    return `${d.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
    })} UTC`;
}

/**
 * Renders a single embed's text fields (no URLs) as a labelled block.
 * Returns an empty string when there are no displayable text fields.
 *
 * `timestamp` is a raw ISO 8601 string on {@link IChatClientMessageEmbed} —
 * formatted here to a verbose UTC string for LLM readability.
 */
function renderEmbed(embed: IChatClientMessageEmbed, index: number): string {
    const lines: string[] = [`Embed #${index + 1}`];
    if (embed.type) lines.push(`Type: ${embed.type}`);
    if (embed.title) lines.push(`Title: ${embed.title}`);
    // YouTube descriptions are full of links & SEO dumps — omit to avoid
    // flooding the LLM context with content that rarely adds conversational value.
    if (embed.description && embed.providerName !== "YouTube") lines.push(`Description: ${embed.description}`);
    if (embed.authorName) lines.push(`Author: ${embed.authorName}`);
    if (embed.providerName) lines.push(`Source: ${embed.providerName}`);
    if (embed.timestamp) lines.push(`Date: ${formatUtcTimestamp(new Date(embed.timestamp))}`);
    if (embed.fields?.length) {
        lines.push("Fields: ");
        for (const field of embed.fields) {
            lines.push(`${field.name}: ${field.value}`);
        }
    }
    if (embed.footerText) lines.push(`Footer: ${embed.footerText}`);
    // URL fields (video/image/thumbnail) are intentionally omitted — used for media, not text context
    return lines.join("\n");
}

/**
 * Returns the "Embedded content:" block for a set of embeds, or `""` if none.
 */
function renderEmbeds(embeds: IChatClientMessageEmbed[]): string {
    if (!embeds?.length) return "";
    return `\nEmbedded content:\n${embeds.map(renderEmbed).join("\n\n")}`;
}

/**
 * Returns the "Forwarded content:" block for a forwarded message snapshot, or `""` if absent.
 */
function renderForwardedSnapshot(snapshot: IChatClientMessageSnapshot | null): string {
    if (!snapshot) return "";
    const lines: string[] = [];
    if (snapshot.cleanContent) lines.push(snapshot.cleanContent);
    else if (snapshot.content) lines.push(snapshot.content);
    const embedsBlock = renderEmbeds(snapshot.embeds);
    if (embedsBlock) lines.push(embedsBlock.trimStart());
    return `\nForwarded content:\n${lines.join("\n")}`;
}

/**
 * Formats a Discord message as LLM-consumable text.
 *
 * Includes:
 * - A header identifying the sender (or "Forwarded message" for Discord forwards)
 * - The message content (`cleanContent` — mention snowflakes resolved, bot mentions stripped by caller)
 * - An "Embedded content:" block for any embed metadata (text fields only, no URLs)
 * - A "Forwarded content:" block when the message is a Discord forward
 *
 * @param message - The live Discord message to format
 * @param strippedContent - Pre-stripped content to use instead of `cleanContent` (bot mentions removed)
 */
export function discordMessageToLlmText(message: IChatClientMessage, strippedContent?: string): string {
    const header = message.isForwarded ? "Forwarded message:" : `Message from user ${message.authorDisplayName}:`;

    const content = strippedContent ?? message.cleanContent;

    // For forwarded messages the embeds live inside forwardedSnapshot — skip
    // the outer embeds block to avoid rendering them twice.
    const embedsBlock = message.isForwarded ? "" : renderEmbeds(message.embeds);
    const forwardedBlock = renderForwardedSnapshot(message.forwardedSnapshot);

    return `${header}\n${content}${embedsBlock}${forwardedBlock}`;
}
