/**
 * Text transformation utilities at the application layer boundary.
 *
 * `llmTextToDiscordText` — sanitizes LLM output for Discord rendering
 * `discordMessageToLlmText` — enriches a Discord message snapshot with sender context for LLM input
 */

import type { DiscordEmbedInfo } from "../ports/IChatMessageService.ts";

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

/**
 * Minimal shape required by {@link discordMessageToLlmText}.
 * `DiscordMessageSnapshot` satisfies this structurally, as do plain inline objects.
 */
type MessageForLlm = {
    authorDisplayName: string;
    content: string;
    embeds?: DiscordEmbedInfo[];
    messageSnapshots?: MessageForLlm[];
    isForwarded?: boolean;
};

/**
 * Renders a single embed's text fields (no URLs) as a labelled block.
 * Returns an empty string when there are no displayable text fields.
 */
function renderEmbed(embed: DiscordEmbedInfo): string {
    const lines: string[] = [`[${embed.type}]`];
    if (embed.title) lines.push(`Title: ${embed.title}`);
    // YouTube descriptions are full of links & SEO dumps — omit to avoid
    // flooding the LLM context with content that rarely adds conversational value.
    if (embed.description && embed.provider?.name !== "YouTube") lines.push(`Description: ${embed.description}`);
    if (embed.author?.name) lines.push(`Author: ${embed.author.name}`);
    if (embed.provider?.name) lines.push(`Source: ${embed.provider.name}`);
    if (embed.timestamp) lines.push(`Date: ${embed.timestamp}`);
    if (embed.fields?.length) {
        lines.push("Fields: ");
        for (const field of embed.fields) {
            lines.push(`${field.name}: ${field.value}`);
        }
    }
    if (embed.footer?.text) lines.push(`Footer: ${embed.footer.text}`);
    // URL fields (video/image/thumbnail) are intentionally omitted — used for media, not text context
    return lines.join("\n");
}

/**
 * Returns the "Embedded content:" block for a set of embeds, or `""` if none.
 */
function renderEmbeds(embeds: DiscordEmbedInfo[] | undefined): string {
    if (!embeds?.length) return "";
    return `\nEmbedded content:\n${embeds.map(renderEmbed).join("\n\n")}`;
}

/**
 * Returns the "Forwarded content:" block for nested message snapshots, or `""` if none.
 */
function renderNestedSnapshots(snapshots: MessageForLlm[] | undefined): string {
    if (!snapshots?.length) return "";
    const parts = snapshots.map((s) => {
        const lines: string[] = [];
        if (s.content) lines.push(s.content);
        const embedsBlock = renderEmbeds(s.embeds);
        if (embedsBlock) lines.push(embedsBlock.trimStart());
        return lines.join("\n");
    });
    return `\nForwarded content:\n${parts.join("\n\n")}`;
}

/**
 * Formats a Discord message snapshot as LLM-consumable text.
 *
 * Includes:
 * - A header identifying the sender (or "Forwarded message" for Discord forwards)
 * - The message content
 * - An "Embedded content:" block for any embed metadata (text fields only, no URLs)
 * - A "Forwarded content:" block for nested message snapshots
 * - An "END" marker when supplementary sections are present
 *
 * The `username` is resolved by the caller with guild-aware priority:
 * server nickname > global display name > username.
 *
 * @param snapshot - Snapshot-shaped object describing the message to format
 */
export function discordMessageToLlmText(snapshot: MessageForLlm): string {
    const header = snapshot.isForwarded ? "Forwarded message:" : `Message from user ${snapshot.authorDisplayName}:`;

    const embedsBlock = renderEmbeds(snapshot.embeds);
    const snapshotsBlock = renderNestedSnapshots(snapshot.messageSnapshots);
    const hasSupplement = embedsBlock !== "" || snapshotsBlock !== "";

    return `${header}\n${snapshot.content}${embedsBlock}${snapshotsBlock}${hasSupplement ? "\nEND" : ""}`;
}
