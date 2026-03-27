import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";
import type { IInvokableModel } from "./IResilientModelInvoker.ts";

/**
 * Port interface for a lazy-caching model provider keyed by API key.
 *
 * Implementations cache model client instances per API key so that expensive
 * construction (HTTP client, auth, LangChain internals) only happens once per key.
 */
export interface IModelProvider {
    /**
     * Returns the model client for the given API key.
     * Creates and caches the client on first call for each key.
     *
     * @param key - The API key record whose `apiKey` string is used to construct the client
     */
    get(key: GeminiApiKey): IInvokableModel;

    /**
     * Returns a fallback model client for the given API key, or `undefined` if no
     * fallback model is configured. The fallback is invoked on 503 or timeout errors
     * in place of the primary model, using the same API key.
     *
     * @param key - The API key record to use for the fallback client
     */
    getFallback(key: GeminiApiKey): IInvokableModel | undefined;
}
