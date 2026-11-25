import { type RetryOptions, retriesNote, retryWithBackoff } from "../../application/services/retryWithBackoff.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { TavilySearchError } from "../../domain/errors/AppError.ts";

/** Tavily API base URL. */
const DEFAULT_ENDPOINT = "https://api.tavily.com";

/** How long a search may take before it is aborted; matches the official SDK's default. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** One retry after half a second: enough to ride out a brief blip without stalling the reply. */
const DEFAULT_RETRY_OPTIONS: RetryOptions = { maxRetries: 1, initialDelayMs: 500 };

/** Minimal fetch signature, so tests can substitute a stub without Bun's extra `fetch` properties. */
type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Settings for {@link TavilySearchClient}; every field has a production default. */
interface TavilySearchClientOptions {
    /** API base URL. */
    endpoint?: string;
    /** Abort a search attempt after this many ms. */
    timeoutMs?: number;
    /** Overrides of the retry policy for transient failures; by default one retry after 500 ms. */
    retry?: Partial<RetryOptions>;
    fetchFn?: FetchFn;
}

/** The `/search` request parameters this application uses; omitted ones take the API's defaults. */
export interface TavilySearchRequest {
    query: string;
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    chunksPerSource?: number;
    includeAnswer?: boolean;
    includeFavicon?: boolean;
    includeImages?: boolean;
    includeImageDescriptions?: boolean;
    includeUsage?: boolean;
}

/** Maps a request to the API's snake_case body. Undefined fields are dropped by JSON.stringify. */
function toRequestBody(request: TavilySearchRequest) {
    return {
        query: request.query,
        max_results: request.maxResults,
        search_depth: request.searchDepth,
        chunks_per_source: request.chunksPerSource,
        include_answer: request.includeAnswer,
        include_favicon: request.includeFavicon,
        include_images: request.includeImages,
        include_image_descriptions: request.includeImageDescriptions,
        include_usage: request.includeUsage,
    };
}

/**
 * Reads the human-readable reason off a Tavily error body, which has the shape
 * `{ detail: { error: string } }`. Returns null for any other body, including non-JSON ones such
 * as a proxy's HTML error page.
 */
function errorDetailOf(rawBody: string): string | null {
    let json: unknown;
    try {
        json = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (typeof json !== "object" || json === null || !("detail" in json)) return null;
    const { detail } = json;
    if (typeof detail !== "object" || detail === null || !("error" in detail)) return null;
    return typeof detail.error === "string" ? detail.error : null;
}

/**
 * A failure the same request may well not run into again: a server-side failure (5xx), or a
 * request that got no response (network failure or timeout). Private to this module, so that
 * only the client decides what is retried; callers see a plain {@link TavilySearchError}.
 */
class TransientTavilySearchError extends TavilySearchError {}

function isTransientSearchError(err: unknown): boolean {
    return err instanceof TransientTavilySearchError;
}

/** Describes why a request got no response at all. */
function describeRequestFailure(err: unknown, timeoutMs: number): string {
    if (err instanceof Error && err.name === "TimeoutError") return `timed out after ${timeoutMs} ms`;
    return err instanceof Error ? err.message : String(err);
}

/**
 * Runs web searches through the Tavily REST `/search` endpoint, with the API key chosen per call
 * so that a caller can rotate keys.
 *
 * Calls the REST API directly rather than through `@langchain/tavily` or `@tavily/core`: the
 * former turns every failure into a successful `{ error }` result with the HTTP status only in
 * the message text, and the latter silently falls back to rate-limited keyless access when given
 * an empty key. Here every failure is thrown as a {@link TavilySearchError} carrying the status.
 *
 * Transient failures (server errors, network failures, timeouts) are retried with exponential
 * backoff on the same key, as the key is not at fault. Key-related failures are thrown at once,
 * so that the caller can rotate keys without waiting.
 */
export class TavilySearchClient {
    private readonly endpoint: string;
    private readonly timeoutMs: number;
    private readonly retryOptions: RetryOptions;
    private readonly fetchFn: FetchFn;

    /**
     * @param logger  - Used to report retried failures
     * @param options - Endpoint, timeout, retry policy and fetch overrides; all have production defaults
     */
    constructor(
        private readonly logger: Logger,
        options: TavilySearchClientOptions = {},
    ) {
        this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // Field by field rather than spread, so that an explicitly undefined override keeps the default
        this.retryOptions = {
            maxRetries: options.retry?.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries,
            initialDelayMs: options.retry?.initialDelayMs ?? DEFAULT_RETRY_OPTIONS.initialDelayMs,
        };
        this.fetchFn = options.fetchFn ?? fetch;
    }

    /**
     * Runs a search with the given API key.
     *
     * @param apiKey  - The Tavily API key to authenticate with
     * @param request - The search query and settings
     * @returns The parsed response body, unvalidated
     * @throws {TavilySearchError} on a non-OK response (with its status) or a body that isn't
     *   valid JSON, and once the retries are used up on a server error or a request that got no
     *   response (network failure or timeout)
     */
    async search(apiKey: string, request: TavilySearchRequest): Promise<unknown> {
        const body = JSON.stringify(toRequestBody(request));
        return retryWithBackoff((retry) => this.sendOnce(apiKey, body, retry), this.retryOptions, {
            isRetryable: isTransientSearchError,
            onRetry: this.warnRetry.bind(this),
        });
    }

    /** Sends one search request; `retry` counts the retries before it, for the error message. */
    private async sendOnce(apiKey: string, body: string, retry: number): Promise<unknown> {
        let response: Response;
        let rawBody: string;
        try {
            response = await this.fetchFn(`${this.endpoint}/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            // Inside the try: the timeout also covers the body, which can fail mid-stream
            rawBody = await response.text();
        } catch (err) {
            const reason = describeRequestFailure(err, this.timeoutMs);
            throw new TransientTavilySearchError(
                `Tavily search request failed${retriesNote(retry)}: ${reason}`,
                null,
                null,
                err,
            );
        }

        if (!response.ok) {
            const detail = errorDetailOf(rawBody);
            const message = `Tavily search failed with HTTP ${response.status}${retriesNote(retry)}${detail === null ? "" : `: ${detail}`}`;
            throw response.status >= 500
                ? new TransientTavilySearchError(message, response.status, rawBody)
                : new TavilySearchError(message, response.status, rawBody);
        }

        try {
            return JSON.parse(rawBody);
        } catch {
            // Not transient: a malformed response would most likely be malformed again
            throw new TavilySearchError("Tavily search response is not valid JSON", null, rawBody);
        }
    }

    private warnRetry(err: unknown, retry: number, delayMs: number): void {
        this.logger.warn(
            {
                retry,
                maxRetries: this.retryOptions.maxRetries,
                delayMs,
                status: err instanceof TavilySearchError ? err.status : null,
                error: err instanceof Error ? err.message : String(err),
            },
            "Tavily search failed transiently; retrying",
        );
    }
}
