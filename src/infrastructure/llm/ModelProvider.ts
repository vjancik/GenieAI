import type { IModelProvider } from "../../application/ports/IModelProvider.ts";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";
import { createGeneralModel, type GeneralModel } from "./models/generalModel.ts";
import { createSearchModel, type SearchModel } from "./models/searchModel.ts";
import { createTriageModel, type TriageAgentDeps, type TriageModel } from "./models/triageModel.ts";

/**
 * Lazy-caching model provider for the triage model.
 *
 * Builds one {@link TriageModel} per unique API key string, caching after first
 * construction. The cache key is the raw `apiKey` string, not the UUID, because
 * `ChatGoogle` and `bindTools` are keyed on the raw key used to initialize the client.
 *
 * If `fallbackModelName` is provided, a separate fallback model instance is also
 * cached per key and returned via {@link getFallback}.
 *
 * Implements {@link IModelProvider} so the orchestrator depends only on the interface.
 */
export class TriageModelProvider implements IModelProvider<TriageModel> {
    private readonly cache = new Map<string, TriageModel>();
    private readonly fallbackCache = new Map<string, TriageModel>();
    readonly modelName: string;

    constructor(private readonly deps: Omit<TriageAgentDeps, "apiKey"> & { fallbackModelName?: string }) {
        this.modelName = deps.modelName;
    }

    /** Returns the triage model for the given key, constructing and caching on first access. */
    get(key: GeminiApiKey): TriageModel {
        const cached = this.cache.get(key.apiKey);
        if (cached) return cached;
        const model = createTriageModel({ ...this.deps, apiKey: key.apiKey });
        this.cache.set(key.apiKey, model);
        return model;
    }

    /**
     * Returns the fallback triage model for the given key, or `undefined` if no fallback
     * model name was configured. The fallback uses the same bound tools as the primary.
     */
    getFallback(key: GeminiApiKey): TriageModel | undefined {
        if (!this.deps.fallbackModelName) return undefined;
        const cached = this.fallbackCache.get(key.apiKey);
        if (cached) return cached;
        const model = createTriageModel({ ...this.deps, modelName: this.deps.fallbackModelName, apiKey: key.apiKey });
        this.fallbackCache.set(key.apiKey, model);
        return model;
    }
}

/**
 * Lazy-caching model provider for the general-purpose model.
 * One {@link GeneralModel} instance per unique API key string.
 *
 * If `fallbackModelName` is provided, a separate fallback model instance is also
 * cached per key and returned via {@link getFallback}.
 */
export class GeneralModelProvider implements IModelProvider<GeneralModel> {
    private readonly cache = new Map<string, GeneralModel>();
    private readonly fallbackCache = new Map<string, GeneralModel>();
    readonly modelName: string;

    constructor(
        private readonly config: {
            modelName: string;
            includeLLMThoughts: boolean;
            fallbackModelName?: string;
        },
    ) {
        this.modelName = config.modelName;
    }

    /** Returns the general model for the given key, constructing and caching on first access. */
    get(key: GeminiApiKey): GeneralModel {
        const cached = this.cache.get(key.apiKey);
        if (cached) return cached;
        const model = createGeneralModel({
            apiKey: key.apiKey,
            modelName: this.config.modelName,
            includeLLMThoughts: this.config.includeLLMThoughts,
        });
        this.cache.set(key.apiKey, model);
        return model;
    }

    /**
     * Returns the fallback general model for the given key, or `undefined` if no fallback
     * model name was configured.
     */
    getFallback(key: GeminiApiKey): GeneralModel | undefined {
        if (!this.config.fallbackModelName) return undefined;
        const cached = this.fallbackCache.get(key.apiKey);
        if (cached) return cached;
        const model = createGeneralModel({
            apiKey: key.apiKey,
            modelName: this.config.fallbackModelName,
            includeLLMThoughts: this.config.includeLLMThoughts,
        });
        this.fallbackCache.set(key.apiKey, model);
        return model;
    }
}

/**
 * Single-instance model provider for the search model.
 *
 * The search model always uses the paid API key (Google Search grounding is
 * paid-only). A single instance is created at construction time — the `key`
 * argument to {@link get} is ignored since there is no key rotation for search.
 *
 * If `fallbackModelName` is provided, a single fallback instance is also created
 * at construction time and returned via {@link getFallback}.
 */
export class SearchModelProvider implements IModelProvider<SearchModel> {
    readonly modelName: string;
    private readonly model: SearchModel;
    private readonly fallbackModel: SearchModel | undefined;

    constructor(
        apiKey: string,
        config: { modelName: string; includeLLMThoughts: boolean; fallbackModelName?: string },
    ) {
        this.modelName = config.modelName;
        this.model = createSearchModel({
            apiKey,
            modelName: config.modelName,
            includeLLMThoughts: config.includeLLMThoughts,
        });
        this.fallbackModel = config.fallbackModelName
            ? createSearchModel({
                  apiKey,
                  modelName: config.fallbackModelName,
                  includeLLMThoughts: config.includeLLMThoughts,
              })
            : undefined;
    }

    /** Returns the single search model instance (key argument is ignored). */
    get(_key: GeminiApiKey): SearchModel {
        return this.model;
    }

    /**
     * Returns the fallback search model instance, or `undefined` if no fallback model
     * name was configured. Key argument is ignored (search always uses a single paid key).
     */
    getFallback(_key: GeminiApiKey): SearchModel | undefined {
        return this.fallbackModel;
    }
}
