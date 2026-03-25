import { COMMAND_PREFIX_REGEX } from "./parseMessageIntent.ts";

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
export function extractUserContent(content: string, botUserId: string, botRoleId: string | null): string {
    // Strip command prefix first — it always appears at the message start before any mention tokens
    const stripped = content.replace(COMMAND_PREFIX_REGEX, "");
    // Strip bot user mention (<@userId> / <@!userId>) and optionally the bot's role mention (<@&roleId>)
    const mentionPattern = botRoleId
        ? new RegExp(`<@!?${botUserId}>|<@&${botRoleId}>`, "g")
        : new RegExp(`<@!?${botUserId}>`, "g");
    return stripped.replace(mentionPattern, "").trim();
}
