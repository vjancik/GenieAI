/**
 * Text transformation utilities for the Discord → LLM boundary.
 *
 * `discordMessageToLlmText` — enriches a stripped Discord message with sender context
 *
 * For the LLM → Discord direction, see `src/application/textTransformers.ts`.
 */

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
