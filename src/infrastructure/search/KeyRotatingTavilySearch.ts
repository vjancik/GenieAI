import type { IRoundRobinKeyProvider } from "../../application/ports/IRoundRobinKeyProvider.ts";
import { type KeyAttemptResult, runWithKeyRotation } from "../../application/services/runWithKeyRotation.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { TavilyApiKey } from "../../domain/entities/TavilyApiKey.ts";
import { AllSearchKeysExhaustedError } from "../../domain/errors/AppError.ts";
import { httpStatusOf } from "../llm/errors/httpStatusOf.ts";
import { isTavilyKeyRotationError } from "../llm/errors/isTavilyKeyRotationError.ts";
import type { TavilySearchClient, TavilySearchRequest } from "./TavilySearchClient.ts";

/** The search settings applied to every query. */
type TavilySearchSettings = Omit<TavilySearchRequest, "query">;

/**
 * Runs Tavily web searches over a pool of API keys, rotating to the next key whenever the
 * current one is rejected, rate-limited or out of credits (see {@link isTavilyKeyRotationError}).
 * The key cursor is shared by all searches, so once a key is found unusable later searches start
 * from the next one.
 *
 * Retrying transient failures on the same key is left to the client.
 */
export class KeyRotatingTavilySearch {
    /**
     * @param client      - Sends the search requests, retrying transient failures itself
     * @param keyProvider - The Tavily key pool
     * @param settings    - Search settings applied to every query
     * @param logger      - Used to report unusable keys
     */
    constructor(
        private readonly client: Pick<TavilySearchClient, "search">,
        private readonly keyProvider: IRoundRobinKeyProvider<TavilyApiKey>,
        private readonly settings: TavilySearchSettings,
        private readonly logger: Logger,
    ) {}

    /**
     * Searches the web for `query`.
     *
     * @returns The parsed, unvalidated Tavily response body
     * @throws {AllSearchKeysExhaustedError} when every key is rejected, rate-limited or out of credits
     * @throws {TavilySearchError} for failures another key cannot fix, as thrown by the client
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
            return { kind: "success", value: await this.client.search(key.apiKey, { ...this.settings, query }) };
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
}
