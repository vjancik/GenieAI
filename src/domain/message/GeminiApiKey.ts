/**
 * Domain entity for a Google API key registered in the system.
 *
 * Keys are synced from environment variables at startup and persisted with a
 * stable UUID so that Gemini file upload records can reference them as foreign keys.
 *
 * Gemini files are project-scoped — a file uploaded with one API key's project
 * is inaccessible from another key's project. The `id` field ties uploads to the
 * key that owns them, enabling per-key refresh and rotation.
 */
export interface GeminiApiKey {
    /** UUID primary key — stable identifier used as FK in gemini_file_uploads */
    id: string;
    /** The raw Google API key string */
    apiKey: string;
    /** Whether this is a paid key (eligible for Google Search grounding) or a free-tier key */
    isPaid: boolean;
}
