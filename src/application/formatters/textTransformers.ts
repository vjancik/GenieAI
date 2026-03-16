/**
 * Text transformation utilities at the application layer boundary.
 *
 * `llmTextToDiscordText` — sanitizes LLM output for Discord rendering
 * `discordMessageToLlmText` — enriches a Discord message with sender context for LLM input
 */

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
    return text.replace(HORIZONTAL_RULE_RE, "").replace(MULTI_BLANK_LINE_RE, "\n").trim();
}

/**
 * Wraps a user's message content with a sender attribution header so the LLM
 * has consistent context about who is speaking.
 *
 * The username is resolved by the caller with guild-aware priority:
 * server nickname > guild display name > global display name.
 *
 * @param username - The resolved display name of the message author
 * @param content  - The stripped message content (bot mention and command prefix already removed)
 */
export function discordMessageToLlmText(username: string, content: string): string {
    return `Message from user ${username}:\n${content}`;
}
