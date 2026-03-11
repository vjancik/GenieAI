/**
 * Represents the user's declared intent for a Discord message.
 *
 * Implemented as a const-object + extracted type (rather than an enum) to allow both
 * value-level use (`MessageIntent.GENERAL`) and type-level exhaustiveness checks.
 *
 * Intents are either inferred from an explicit command prefix (e.g. `!aisearch`)
 * or default to `UNKNOWN` for @mention-triggered messages with no command.
 */
export const MessageIntent = {
    /** Explicit general-purpose request via `!ai` command. */
    GENERAL: "general",
    /** Explicit web search request via `!aisearch` command. */
    SEARCH: "search",
    /** Explicit summarization request via `!aisummary` command. */
    SUMMARY: "summary",
    /** Default for @mention messages — routed through triage. */
    UNKNOWN: "unknown",
} as const;

export type MessageIntent = (typeof MessageIntent)[keyof typeof MessageIntent];
