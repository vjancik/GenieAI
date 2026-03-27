import type { IModelProvider } from "../../application/ports/IModelProvider.ts";
import type { IInvokableModel } from "../../application/ports/IResilientModelInvoker.ts";
import type { GeminiApiKey } from "../../domain/entities/GeminiApiKey.ts";

/**
 * Cache key tuple: `[apiKey, modelName]`.
 * Using a composite key allows a single map to hold both primary and fallback
 * model instances without a second map or a two-level nested structure.
 */
type ModelCacheKey = `${string}::${string}`;

function toCacheKey(apiKey: string, modelName: string): ModelCacheKey {
    return `${apiKey}::${modelName}`;
}

/**
 * Abstract base class for lazy-caching model providers.
 *
 * Handles all caching logic so that concrete providers only need to implement
 * {@link create}, which constructs a new model instance for a given API key and
 * model name. Both primary and fallback instances share the same cache map,
 * distinguished by the composite `[apiKey, modelName]` key.
 *
 * Subclasses must supply `primaryModelName` and optionally `fallbackModelName`
 * to the super constructor. {@link modelName} is an implementation-level property
 * used internally for caching and model construction — it is not exposed through
 * the {@link IModelProvider} port.
 */
export abstract class ModelProvider implements IModelProvider {
    private readonly cache = new Map<ModelCacheKey, IInvokableModel>();

    constructor(
        protected readonly modelName: string,
        protected readonly fallbackModelName: string | undefined,
    ) {}

    /**
     * Constructs a new model instance for the given API key and model name.
     * Called at most once per unique `[apiKey, modelName]` pair — subsequent
     * calls for the same pair return the cached instance.
     */
    protected abstract create(apiKey: string, modelName: string): IInvokableModel;

    /**
     * Returns (or lazily constructs) the primary model client for the given key.
     */
    get(key: GeminiApiKey): IInvokableModel {
        return this.getOrCreate(key.apiKey, this.modelName);
    }

    /**
     * Returns (or lazily constructs) the fallback model client for the given key,
     * or `undefined` if no fallback model name was configured.
     */
    getFallback(key: GeminiApiKey): IInvokableModel | undefined {
        if (!this.fallbackModelName) return undefined;
        return this.getOrCreate(key.apiKey, this.fallbackModelName);
    }

    protected getOrCreate(apiKey: string, modelName: string): IInvokableModel {
        const cacheKey = toCacheKey(apiKey, modelName);
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        const model = this.create(apiKey, modelName);
        this.cache.set(cacheKey, model);
        return model;
    }
}
