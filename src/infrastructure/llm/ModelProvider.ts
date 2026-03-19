import type { IModelProvider } from "../../application/ports/IModelProvider.ts";
import type { GeminiApiKey } from "../../domain/message/GeminiApiKey.ts";

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
 * to the super constructor.
 *
 * @template T - The concrete model client type (e.g. `ChatGoogle` with bound tools)
 */
export abstract class ModelProvider<T> implements IModelProvider<T> {
    private readonly cache = new Map<ModelCacheKey, T>();

    constructor(
        readonly modelName: string,
        protected readonly fallbackModelName: string | undefined,
    ) {}

    /**
     * Constructs a new model instance for the given API key and model name.
     * Called at most once per unique `[apiKey, modelName]` pair — subsequent
     * calls for the same pair return the cached instance.
     */
    protected abstract create(apiKey: string, modelName: string): T;

    /**
     * Wraps a model instance so that `.invoke()` races against a manual
     * `AbortController` timer, working around a bug in `@langchain/google`
     * where `RunnableConfig.timeout` is not wired to the fetch `AbortSignal`
     * on the non-streaming code path, causing stalled API calls to hang forever.
     *
     * The underlying fetch is NOT cancelled (the library bug prevents that), so
     * the API request will run to completion in the background — accepted cost.
     *
     * Remove this wrapper once the upstream bug is fixed and our regression test
     * in `tests/unit/llm/chatGoogleTimeout.test.ts` starts failing.
     *
     * @see {@link ./docs/upstream_bugs/langchain-google-non-streaming-invoke-ignores-timeout.md}
     */
    private withTimeoutFix(model: T): T {
        // Only patch if the model has an invoke method — all our ChatGoogle
        // variants do, but this keeps the base class generic.
        if (typeof (model as { invoke?: unknown }).invoke !== "function") return model;

        const patched = Object.create(model as object) as T & {
            invoke(messages: unknown, options?: { timeout?: number }): Promise<unknown>;
        };

        patched.invoke = async function (
            this: void,
            messages: unknown,
            options?: { timeout?: number },
        ): Promise<unknown> {
            const timeoutMs = options?.timeout;

            // No timeout configured — delegate directly, no race needed.
            if (timeoutMs === undefined) {
                return (model as typeof patched).invoke(messages, options);
            }

            // Race the invoke against a manual AbortController timer.
            // When the timer wins we reject with a TimeoutError so that
            // isTimeoutError() and the fallback logic upstream recognise it.
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
                timeoutMs,
            );

            return Promise.race([
                (model as typeof patched).invoke(messages, options).finally(() => clearTimeout(timer)),
                new Promise<never>((_, reject) => {
                    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
                        once: true,
                    });
                }),
            ]);
        };

        return patched;
    }

    /**
     * Constructs a new model instance via {@link create} and wraps it with the
     * timeout workaround for the upstream `@langchain/google` bug.
     */
    private createWithTimeoutFix(apiKey: string, modelName: string): T {
        return this.withTimeoutFix(this.create(apiKey, modelName));
    }

    /**
     * Returns (or lazily constructs) the primary model client for the given key.
     */
    get(key: GeminiApiKey): T {
        return this.getOrCreate(key.apiKey, this.modelName);
    }

    /**
     * Returns (or lazily constructs) the fallback model client for the given key,
     * or `undefined` if no fallback model name was configured.
     */
    getFallback(key: GeminiApiKey): T | undefined {
        if (!this.fallbackModelName) return undefined;
        return this.getOrCreate(key.apiKey, this.fallbackModelName);
    }

    protected getOrCreate(apiKey: string, modelName: string): T {
        const cacheKey = toCacheKey(apiKey, modelName);
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        const model = this.createWithTimeoutFix(apiKey, modelName);
        this.cache.set(cacheKey, model);
        return model;
    }
}
