/**
 * Text transformation utilities at the application layer boundary.
 *
 * `llmTextToDiscordText` — sanitizes LLM output for Discord rendering
 * `discordMessageToLlmText` — enriches a Discord message with sender context for LLM input
 */

import type {
    IChatClientMessage,
    IChatClientMessageEmbed,
    IChatClientMessageSnapshot,
} from "../ports/chat/IChatClient.ts";

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
 * already suppressed.  The URL body stops at the first whitespace or angle
 * bracket; any trailing punctuation it over-captures is given back by
 * {@link trimTrailingPunctuation}.
 */
const BARE_URL_RE = /(?<!<)https?:\/\/[^\s<>]+/g;

/**
 * Characters that are technically legal in a URL but, at the very end of one,
 * are overwhelmingly sentence punctuation or Markdown syntax — e.g. the `)**`
 * closing a bold masked link, or the `.` ending a sentence.
 */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"', "`", "*", "_", "~", ")", "]", "}"]);

/**
 * Strips trailing punctuation that belongs to the surrounding prose or Markdown
 * rather than to the URL itself.
 *
 * Closing parens are a special case: one is kept when it pairs with an opening
 * paren inside the URL (e.g. Wikipedia's `/wiki/Nginx_(web_server)`), and only
 * unbalanced ones — such as the `)` closing a `[label](url)` link — are dropped.
 *
 * @param url - Raw URL match, possibly with punctuation glued to its end
 * @returns The URL with the trailing punctuation run removed
 */
function trimTrailingPunctuation(url: string): string {
    let openParens = 0;
    let closeParens = 0;
    for (const char of url) {
        if (char === "(") openParens++;
        else if (char === ")") closeParens++;
    }

    let end = url.length;
    while (end > 0) {
        const char = url[end - 1];
        if (char === undefined || !TRAILING_PUNCTUATION.has(char)) break;
        if (char === ")") {
            // A balanced closing paren is part of the URL — stop here.
            if (closeParens <= openParens) break;
            closeParens--;
        }
        end--;
    }

    return url.slice(0, end);
}

/**
 * Replacer for {@link BARE_URL_RE} that wraps the URL in `<…>` to suppress
 * Discord's link embed, re-emitting any over-captured trailing punctuation
 * outside the closing bracket.
 */
function suppressUrlEmbed(match: string): string {
    const url = trimTrailingPunctuation(match);
    return `<${url}>${match.slice(url.length)}`;
}

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
 * Regex that matches a Markdown ATX heading deeper than h3 (`####`, `#####`,
 * `######`) at the start of a line.
 *
 * Discord only renders h1–h3, so deeper headings would otherwise show up as
 * literal `#` characters.  The pattern requires:
 * - Start of line, capturing any leading horizontal whitespace
 * - Four to six `#`, not followed by another `#` (so `#######` — not a valid
 *   ATX heading anyway — is left alone)
 * - A following space/tab, since ATX headings require one (`####Text` is not a heading)
 *
 * The `m` flag makes `^` match per line.
 */
const DEEP_HEADING_RE = /^([ \t]*)#{4,6}(?!#)(?=[ \t])/gm;

/**
 * Prepares LLM-generated text for display in Discord by removing formatting
 * constructs that Discord does not render or that produce excessive whitespace.
 *
 * Transformations applied (in order):
 * 1. Demote h4–h6 headings to h3 (Discord renders no deeper than `###`)
 * 2. Strip Markdown horizontal rules (`---`, `***`, `___` on their own line)
 * 3. Collapse multiple consecutive blank lines into a single newline
 * 4. Wrap bare URLs in `<…>` to suppress link embeds
 * 5. Trim leading and trailing whitespace
 *
 * @param text - Raw LLM response text
 */
export function llmTextToDiscordText(text: string): string {
    return text
        .replace(DEEP_HEADING_RE, "$1###")
        .replace(HORIZONTAL_RULE_RE, "")
        .replace(MULTI_BLANK_LINE_RE, "\n")
        .replace(BARE_URL_RE, suppressUrlEmbed)
        .trim();
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
