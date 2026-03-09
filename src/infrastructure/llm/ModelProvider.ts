import type { IModelProvider } from "../../application/ports/IModelProvider.ts";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";
import {
    createGeneralModel,
    type GeneralModel,
} from "./agents/generalAgent.ts";
import { createSearchModel, type SearchModel } from "./agents/searchAgent.ts";
import {
    createTriageModel,
    type TriageAgentDeps,
    type TriageModel,
} from "./agents/triageAgent.ts";

/**
 * Lazy-caching model provider for the triage model.
 *
 * Builds one {@link TriageModel} per unique API key string, caching after first
 * construction. The cache key is the raw `apiKey` string, not the UUID, because
 * `ChatGoogle` and `bindTools` are keyed on the raw key used to initialize the client.
 *
 * Implements {@link IModelProvider} so the orchestrator depends only on the interface.
 */
export class TriageModelProvider implements IModelProvider<TriageModel> {
    private readonly cache = new Map<string, TriageModel>();
    readonly modelName: string;

    constructor(private readonly deps: Omit<TriageAgentDeps, "apiKey">) {
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
}

/**
 * Lazy-caching model provider for the general-purpose model.
 * One {@link GeneralModel} instance per unique API key string.
 */
export class GeneralModelProvider implements IModelProvider<GeneralModel> {
    private readonly cache = new Map<string, GeneralModel>();
    readonly modelName: string;

    constructor(
        private readonly config: {
            modelName: string;
            includeLLMThoughts: boolean;
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
            ...this.config,
        });
        this.cache.set(key.apiKey, model);
        return model;
    }
}

/**
 * Single-instance model provider for the search model.
 *
 * The search model always uses the paid API key (Google Search grounding is
 * paid-only). A single instance is created at construction time — the `key`
 * argument to {@link get} is ignored since there is no key rotation for search.
 */
export class SearchModelProvider implements IModelProvider<SearchModel> {
    readonly modelName: string;
    private readonly model: SearchModel;

    constructor(
        apiKey: string,
        config: { modelName: string; includeLLMThoughts: boolean },
    ) {
        this.modelName = config.modelName;
        this.model = createSearchModel({ apiKey, ...config });
    }

    /** Returns the single search model instance (key argument is ignored). */
    get(_key: GeminiApiKey): SearchModel {
        return this.model;
    }
}
