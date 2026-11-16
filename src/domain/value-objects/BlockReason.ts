/**
 * Reason the model provider refused to process a prompt at all, as reported by the Gemini API
 * in `promptFeedback.blockReason`. Unlike a {@link FinishReason}, which describes how generation
 * of an answer ended, a block reason means no answer was generated: the input itself was rejected.
 *
 * Implemented as a const-object + extracted type (rather than an enum) to allow both
 * value-level use (`BlockReason.SAFETY`) and type-level exhaustiveness checks.
 *
 * Keys are identical to their values so the set of valid values can be derived directly
 * from the object for parsing.
 */
export const BlockReason = {
    /** Default API value. Documented as unused, treated as a generic block if seen. */
    BLOCK_REASON_UNSPECIFIED: "BLOCK_REASON_UNSPECIFIED",
    /** The prompt was blocked for safety reasons. */
    SAFETY: "SAFETY",
    /** The prompt was blocked for an unknown reason. */
    OTHER: "OTHER",
    /** The prompt was blocked because it contains terms from the terminology blocklist. */
    BLOCKLIST: "BLOCKLIST",
    /** The prompt was blocked because it contains prohibited content. */
    PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
    /** The prompt was blocked because it contains unsafe images. */
    IMAGE_SAFETY: "IMAGE_SAFETY",
} as const;

export type BlockReason = (typeof BlockReason)[keyof typeof BlockReason];

/** Lookup set for {@link parseBlockReason}, built once from the const object. */
const BLOCK_REASON_VALUES: ReadonlySet<string> = new Set<string>(Object.values(BlockReason));

/**
 * Normalizes a raw `blockReason` value reported by the model provider.
 *
 * @param raw - The provider-reported value, typically a string but untyped at the boundary
 * @returns The matching {@link BlockReason}. Missing and unrecognized values map to
 *   {@link BlockReason.OTHER}: the prompt was blocked either way, so a newly added API enum
 *   member degrades into a generic block rather than being dropped.
 */
export function parseBlockReason(raw: unknown): BlockReason {
    if (typeof raw !== "string") return BlockReason.OTHER;
    const normalized = raw.toUpperCase();
    // TYPE COERCION: guarded by the membership check against BLOCK_REASON_VALUES, which is
    // built exclusively from BlockReason values, so the string is a BlockReason here.
    if (BLOCK_REASON_VALUES.has(normalized)) return normalized as BlockReason;
    return BlockReason.OTHER;
}
