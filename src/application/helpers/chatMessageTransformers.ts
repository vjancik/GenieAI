import { MessageIntent } from "../../domain/value-objects/MessageIntent.ts";

/**
 * Maps recognized bot command prefixes to their corresponding {@link MessageIntent}.
 * Commands must appear at the start of a message, followed by at least one whitespace.
 * Matching is case-insensitive to accommodate phone auto-capitalization.
 *
 * Defined in the application layer so any delivery mechanism can resolve intent
 * without duplicating or importing from a concrete adapter.
 *
 * Add new commands here — the rest of the pipeline picks up the intent automatically.
 */
export const COMMAND_INTENT_MAP: Record<string, MessageIntent> = {
    "!ai": MessageIntent.GENERAL,
    "!aisearch": MessageIntent.SEARCH,
    "!aisummary": MessageIntent.SUMMARY,
};

/**
 * Builds a regex that matches any recognized command prefix at the start of the string,
 * followed by one or more whitespace characters. Case-insensitive.
 *
 * Longer commands are sorted first to prevent `!ai` from shadowing `!aisearch` / `!aisummary`.
 */
function buildCommandPrefixRegex(): RegExp {
    const sorted = Object.keys(COMMAND_INTENT_MAP).sort((a, b) => b.length - a.length);
    const escaped = sorted.map((cmd) => cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^(?:${escaped.join("|")})\\s+`, "i");
}

export const COMMAND_PREFIX_REGEX = buildCommandPrefixRegex();

/**
 * Resolves the {@link MessageIntent} for a raw message string by checking for a
 * recognized command prefix at the start of the content (case-insensitive).
 * Returns {@link MessageIntent.UNKNOWN} if no recognized prefix is found.
 *
 * @param rawContent - The raw message string before any stripping
 */
export function parseMessageIntent(rawContent: string): MessageIntent {
    const match = COMMAND_PREFIX_REGEX.exec(rawContent);
    if (!match) return MessageIntent.UNKNOWN;
    // TYPE COERCION: match[0] is the matched prefix+whitespace; slice to get just the command token
    // and lowercase it to normalize for the map lookup.
    const command = match[0].trimEnd().toLowerCase();
    return COMMAND_INTENT_MAP[command] ?? MessageIntent.UNKNOWN;
}

/**
 * Strips bot @mention tokens, the bot's managed role mention token, and any leading
 * command prefix (e.g. `!ai`, `!aisearch`) from the message content in a single pass.
 *
 * Discord encodes user mentions as `<@userId>` or `<@!userId>` (legacy nickname format),
 * and role mentions as `<@&roleId>`. The bot's managed role ID is sourced from the guild
 * member object at call time, so only the bot's own role mention is stripped rather than
 * all role mentions. In DMs there are no role mentions, so `botRoleId` will be null and
 * the role-stripping step is skipped entirely.
 *
 * Command stripping is case-insensitive to accommodate phone auto-capitalization.
 * The command prefix is only stripped when it appears at the start of the content,
 * followed by at least one whitespace character.
 *
 * @param content - The raw message content string
 * @param botUserId - The bot's Discord user ID
 * @param botRoleId - The bot's managed role ID in this guild, or null for DMs
 * @returns Trimmed message content without the bot's user/role mention tokens or command prefix
 */
export function removeMentionsAndCommandPrefix(content: string, botUserId: string, botRoleId: string | null): string {
    // Strip command prefix first — it always appears at the message start before any mention tokens
    const stripped = content.replace(COMMAND_PREFIX_REGEX, "");
    // Strip bot user mention (<@userId> / <@!userId>) and optionally the bot's role mention (<@&roleId>)
    const mentionPattern = botRoleId
        ? new RegExp(`<@!?${botUserId}>|<@&${botRoleId}>`, "g")
        : new RegExp(`<@!?${botUserId}>`, "g");
    return stripped.replace(mentionPattern, "").trim();
}
