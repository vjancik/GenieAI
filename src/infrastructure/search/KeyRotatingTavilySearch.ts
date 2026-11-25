import type { IRoundRobinKeyProvider } from "../../application/ports/IRoundRobinKeyProvider.ts";
import { type RetryOptions, retryWithBackoff } from "../../application/services/retryWithBackoff.ts";
import { type KeyAttemptResult, runWithKeyRotation } from "../../application/services/runWithKeyRotation.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { TavilyApiKey } from "../../domain/entities/TavilyApiKey.ts";
import { AllSearchKeysExhaustedError, TavilySearchError } from "../../domain/errors/AppError.ts";
import { httpStatusOf } from "../llm/errors/httpStatusOf.ts";
import { isTavilyKeyRotationError } from "../llm/errors/isTavilyKeyRotationError.ts";
import type { TavilySearchClient, TavilySearchRequest } from "./TavilySearchClient.ts";

/** The search settings applied to every query. */
type TavilySearchSettings = Omit<TavilySearchRequest, "query">;

/** One retry after half a second: enough to ride out a brief blip without stalling the reply. */
const DEFAULT_RETRY_OPTIONS: RetryOptions = { maxRetries: 1, initialDelayMs: 500 };

/**
 * Whether a search failed transiently, so the same request with the same key may well succeed:
 * a server-side failure (5xx), or a request that got no response (network failure or timeout).
 * A malformed OK response is not retried, as it would most likely be malformed again.
 */
function isTransientSearchError(err: unknown): boolean {
    if (!(err instanceof TavilySearchError)) return false;
    return err.status === null ? err.body === null : err.status >= 500;
}

/**
 * Runs Tavily web searches over a pool of API keys, rotating to the next key whenever the
 * current one is rejected, rate-limited or out of credits (see {@link isTavilyKeyRotationError}).
 * The key cursor is shared by all searches, so once a key is found unusable later searches start
 * from the next one.
 *
 * Transient failures (see {@link isTransientSearchError}) are retried on the same key with
 * exponential backoff before being thrown; they don't cause rotation, as the key isn't at fault.
 */
export class KeyRotatingTavilySearch {
    private readonly retryOptions: RetryOptions;

    /**
     * @param client      - Sends the search requests
     * @param keyProvider - The Tavily key pool
     * @param settings    - Search settings applied to every query
     * @param logger      - Used to report unusable keys and retried failures
     * @param retry       - Overrides of the retry policy for transient failures; by default one
     *                      retry after 500 ms
     */
    constructor(
        private readonly client: Pick<TavilySearchClient, "search">,
        private readonly keyProvider: IRoundRobinKeyProvider<TavilyApiKey>,
        private readonly settings: TavilySearchSettings,
        private readonly logger: Logger,
        retry: Partial<RetryOptions> = {},
    ) {
        // Field by field rather than spread, so that an explicitly undefined override keeps the default
        this.retryOptions = {
            maxRetries: retry.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries,
            initialDelayMs: retry.initialDelayMs ?? DEFAULT_RETRY_OPTIONS.initialDelayMs,
        };
    }

    /**
     * Searches the web for `query`.
     *
     * @returns The parsed, unvalidated Tavily response body
     * @throws {AllSearchKeysExhaustedError} when every key is rejected, rate-limited or out of credits
     * @throws {TavilySearchError} for failures another key cannot fix: immediately for a bad
     *   request or a malformed response, after the retries for a server error, network failure
     *   or timeout
     */
    async search(query: string): Promise<unknown> {
        const rotation = await runWithKeyRotation(this.keyProvider, (key, attempt) =>
            this.attemptWithKey(key, attempt, query),
        );
        if (rotation.kind === "exhausted") throw new AllSearchKeysExhaustedError(rotation.lastError);
        return rotation.value;
    }

    private async attemptWithKey(
        key: TavilyApiKey,
        attempt: number,
        query: string,
    ): Promise<KeyAttemptResult<unknown>> {
        try {
            const value = await retryWithBackoff(
                () => this.client.search(key.apiKey, { ...this.settings, query }),
                this.retryOptions,
                {
                    isRetryable: isTransientSearchError,
                    onRetry: (err, retry, delayMs) => this.warnRetry(key, err, retry, delayMs),
                },
            );
            return { kind: "success", value };
        } catch (err) {
            if (!isTavilyKeyRotationError(err)) throw err;
            this.logger.warn(
                {
                    attempt,
                    apiKeyId: key.id,
                    status: httpStatusOf(err),
                    error: err instanceof Error ? err.message : String(err),
                },
                "Tavily API key rejected, rate-limited or out of credits; trying next key if one is left",
            );
            return { kind: "keyUnusable", error: err };
        }
    }

    private warnRetry(key: TavilyApiKey, err: unknown, retry: number, delayMs: number): void {
        this.logger.warn(
            {
                retry,
                maxRetries: this.retryOptions.maxRetries,
                delayMs,
                apiKeyId: key.id,
                status: httpStatusOf(err),
                error: err instanceof Error ? err.message : String(err),
            },
            "Tavily search failed transiently; retrying",
        );
    }
}
