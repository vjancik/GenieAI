/**
 * Gemini thinking level values accepted by the @langchain/google library.
 *
 * Implemented as a const-object + extracted type (rather than an enum) to allow both
 * value-level use (`ThinkingLevelType.HIGH`) and type-level narrowing.
 *
 * @langchain/google auto-converts the level to a numeric thinkingBudget for Gemini 2.x
 * models, and passes it directly as thinkingLevel for Gemini 3.x models.
 * Both upper- and lowercase are accepted by the library.
 */
export const ThinkingLevel = {
    THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
} as const;

export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];

/** All valid ThinkingLevel values, used for parsing and validation. */
export const THINKING_LEVELS = Object.values(ThinkingLevel) as readonly ThinkingLevel[];
