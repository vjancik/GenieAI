/**
 * Utilities for extracting and formatting Google Search grounding sources
 * from LangChain AIMessage additional_kwargs.
 *
 * The `groundingMetadata.groundingChunks` array may contain chunks of various
 * types (web, retrievedContext, etc.). Only `web` chunks are surfaced here.
 */

import { z } from "zod";

const WebChunkSchema = z.object({ uri: z.string(), title: z.string() });

/** A single resolved web source with its display title and shortened URL. */
export type WebSource = { title: string; url: string };

/**
 * Zod schema for a single grounding chunk.
 *
 * The array may contain objects without a `web` property (other chunk types
 * such as retrievedContext). Those are ignored — we only extract `web` entries.
 * Additional properties at both levels are permitted for forward-compatibility.
 */
const GroundingChunkSchema = z.object({ web: WebChunkSchema.optional() });

/**
 * Zod schema for the `groundingMetadata` block inside `additional_kwargs`.
 * Only the `groundingChunks` array is required; all other Google-specific
 * properties are ignored.
 */
const GroundingMetadataSchema = z.object({
    groundingChunks: z.array(GroundingChunkSchema),
});

/**
 * Zod schema for the relevant slice of `AIMessage.additional_kwargs`.
 * All other kwargs properties are ignored.
 */
const AdditionalKwargsSchema = z.object({
    groundingMetadata: GroundingMetadataSchema,
});

/**
 * Extracts web grounding source URIs and titles from an AIMessage's
 * `additional_kwargs`. Returns an empty array if the shape is absent or
 * does not pass validation (e.g. non-search responses).
 *
 * @param additionalKwargs - The `additional_kwargs` object from an AIMessage
 */
export function extractWebGroundingChunks(additionalKwargs: unknown): Array<{ uri: string; title: string }> {
    const parsed = AdditionalKwargsSchema.safeParse(additionalKwargs);
    if (!parsed.success) return [];

    return parsed.data.groundingMetadata.groundingChunks.map((chunk) => chunk.web).filter((web) => web !== undefined);
}

/**
 * Formats resolved web sources as a Discord-flavored Markdown sources line.
 *
 * Output format: `*Sources: [Title 1](url1), [Title 2](url2), ...*`
 *
 * Sources are appended one by one. If adding the next source would exceed
 * `maxLength`, the function stops at a safe boundary — never mid-link —
 * and the trailing `, ` separator is trimmed before closing the italics.
 *
 * Returns `null` if the sources array is empty.
 *
 * @param sources - Resolved web sources (title + URL pairs)
 * @param maxLength - Maximum character length for the returned string (default: 2000)
 */
export function formatGroundingSources(sources: WebSource[], maxLength = 2000): string | null {
    if (sources.length === 0) return null;

    const PREFIX = "*Sources: ";
    const SUFFIX = "*";
    const SEP = ", ";

    const links: string[] = [];
    // Running total of link character lengths; separators are accounted for separately
    let linksLength = 0;

    for (const { title, url } of sources) {
        const link = `[${title}](<${url}>)`;
        const separatorsLength = links.length * SEP.length;
        // Check if adding this link would exceed: PREFIX + links + separators + SUFFIX
        if (PREFIX.length + linksLength + separatorsLength + link.length + SUFFIX.length > maxLength) {
            if (links.length === 0) return null;
            break;
        }
        links.push(link);
        linksLength += link.length;
    }

    return `${PREFIX}${links.join(SEP)}${SUFFIX}`;
}
