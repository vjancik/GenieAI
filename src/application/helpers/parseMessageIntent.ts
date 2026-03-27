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
