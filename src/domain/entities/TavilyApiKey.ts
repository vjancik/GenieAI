/**
 * A Tavily Search API key from the configured pool.
 *
 * Unlike Gemini keys, Tavily keys own no persisted resources, so they live in memory only and
 * their `id` is derived from their position in the configured list.
 */
export interface TavilyApiKey {
    /** Stable identifier, safe to log in place of the key, e.g. `tavily-1` */
    id: string;
    /** The raw Tavily API key string */
    apiKey: string;
}

/**
 * Builds the Tavily key pool from the configured keys, numbering them from 1 in the configured
 * order, which is also their rotation order.
 *
 * @param apiKeys - The raw keys, in rotation order
 */
export function toTavilyApiKeys(apiKeys: readonly string[]): TavilyApiKey[] {
    return apiKeys.map((apiKey, index) => ({ id: `tavily-${index + 1}`, apiKey }));
}
