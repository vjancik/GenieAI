import type { ITokenCounter, TokenCountRequest } from "../../../application/ports/ITokenCounter.ts";
import { TokenCountError } from "../../../domain/errors/AppError.ts";

/** Gemini Developer API base URL, matching the endpoint the `ChatGoogle` models call. */
const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/** How long a count may take before it is aborted, so a stalled count can't hold up the model call. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimal fetch signature, so tests can substitute a stub without Bun's extra `fetch` properties. */
type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Settings for {@link GeminiTokenCounter}; every field has a production default. */
interface GeminiTokenCounterOptions {
    /** API base URL including the version segment. */
    endpoint?: string;
    /** Abort a count after this many ms. */
    timeoutMs?: number;
    fetchFn?: FetchFn;
}

/**
 * Reads `totalTokens` off a `countTokens` response body. The API omits the field when it is zero
 * (proto3 default), so an object without it counts as zero tokens.
 *
 * @throws {TokenCountError} when the body is not an object or `totalTokens` is not a number
 */
function parseTotalTokens(json: unknown, rawBody: string): number {
    if (typeof json !== "object" || json === null) {
        throw new TokenCountError("countTokens response is not a JSON object", null, rawBody);
    }
    if (!("totalTokens" in json)) return 0;
    if (typeof json.totalTokens !== "number") {
        throw new TokenCountError("countTokens response has a non-numeric totalTokens", null, rawBody);
    }
    return json.totalTokens;
}

/**
 * Counts input tokens through the Gemini REST `models.countTokens` endpoint.
 *
 * Calls the REST API directly rather than `@google/genai`, because the SDK refuses `systemInstruction`
 * and `tools` in Gemini Developer API mode, while the REST endpoint accepts a full
 * `generateContentRequest` and so counts the request exactly as it will be sent.
 */
export class GeminiTokenCounter implements ITokenCounter {
    private readonly endpoint: string;
    private readonly timeoutMs: number;
    private readonly fetchFn: FetchFn;

    constructor(options: GeminiTokenCounterOptions = {}) {
        this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchFn = options.fetchFn ?? fetch;
    }

    async countTokens({ model, apiKey, request }: TokenCountRequest) {
        const response = await this.fetchFn(`${this.endpoint}/models/${encodeURIComponent(model)}:countTokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            // `model` is required inside generateContentRequest and must match the path's model
            body: JSON.stringify({ generateContentRequest: { ...request, model: `models/${model}` } }),
            signal: AbortSignal.timeout(this.timeoutMs),
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new TokenCountError(
                `countTokens request failed with HTTP ${response.status}`,
                response.status,
                rawBody,
            );
        }

        let json: unknown;
        try {
            json = JSON.parse(rawBody);
        } catch {
            throw new TokenCountError("countTokens response is not valid JSON", null, rawBody);
        }
        return parseTotalTokens(json, rawBody);
    }
}
