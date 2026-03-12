import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

/**
 * Port interface for a lazy-caching model provider keyed by API key.
 *
 * Implementations cache model client instances per API key so that expensive
 * construction (HTTP client, auth, LangChain internals) only happens once per key.
 *
 * The {@link modelName} getter is used by the orchestrator to construct
 * model-specific metadata (e.g. LangSmith run names) and to determine
 * whether the model is a Gemini model without relying on `instanceof` checks.
 *
 * @template T - The concrete model client type (e.g. `ChatGoogle`)
 */
export interface IModelProvider<T> {
    /**
     * The Gemini model name string (e.g. `"gemini-2.0-flash"`).
     * Used by the orchestrator for metadata and model-specific guards.
     */
    readonly modelName: string;

    /**
     * Returns the model client for the given API key.
     * Creates and caches the client on first call for each key.
     *
     * @param key - The API key record whose `apiKey` string is used to construct the client
     */
    get(key: GeminiApiKey): T;

    /**
     * Returns a fallback model client for the given API key, or `undefined` if no
     * fallback model is configured. The fallback is invoked on 503 or timeout errors
     * in place of the primary model, using the same API key.
     *
     * @param key - The API key record to use for the fallback client
     */
    getFallback(key: GeminiApiKey): T | undefined;
}
