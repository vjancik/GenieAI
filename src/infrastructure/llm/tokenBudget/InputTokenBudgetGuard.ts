import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import * as Sentry from "@sentry/bun";
import type { ITokenCounter } from "../../../application/ports/ITokenCounter.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import type { GeminiApiKey } from "../../../domain/entities/GeminiApiKey.ts";
import { InputTokenBudgetExceededError } from "../../../domain/errors/AppError.ts";

/**
 * Prefix of the custom callback event `@langchain/google` dispatches right before sending a request,
 * suffixed with the API handler's class name (e.g. `google-request-GenerateContentApiHandler`).
 */
const GOOGLE_REQUEST_EVENT_PREFIX = "google-request-";

/** Payload of a `google-request-*` event: the exact request about to be sent. */
interface GoogleRequestEvent {
    url: string;
    body: Readonly<Record<string, unknown>>;
}

function isGoogleRequestEvent(data: unknown): data is GoogleRequestEvent {
    return (
        typeof data === "object" &&
        data !== null &&
        "url" in data &&
        typeof data.url === "string" &&
        "body" in data &&
        typeof data.body === "object" &&
        data.body !== null
    );
}

/**
 * Extracts the model name from a generate-content URL, e.g. `gemini-3.5-flash` from
 * `https://…/v1beta/models/gemini-3.5-flash:generateContent`. Returns null for an unknown shape.
 */
function modelFromUrl(url: string): string | null {
    return /\/models\/([^/:?]+):/.exec(url)?.[1] ?? null;
}

/** A budget check spanning one logical model invocation, shared by all of its attempts. */
export interface IInputTokenBudgetCheck {
    /** Returns the callback handler to attach to a model call made with `key`. */
    handlerFor(key: GeminiApiKey): BaseCallbackHandler;
}

/** Guards model calls against inputs larger than a token budget. */
export interface IInputTokenBudgetGuard {
    /**
     * Starts the check for one logical invocation. Every model call made for the invocation (key
     * rotation retries, fallback and parallel calls) must use the returned check, so the input is
     * counted only once.
     */
    forRequest(): IInputTokenBudgetCheck;
}

/**
 * Hooks into `@langchain/google`'s pre-request event and hands the request to `onRequest`.
 * `raiseError` makes LangChain await the handler and rethrow its error, so a throwing `onRequest`
 * aborts the model call before anything is sent.
 */
class InputTokenBudgetCallbackHandler extends BaseCallbackHandler {
    name = "InputTokenBudgetCallbackHandler";

    constructor(private readonly onRequest: (event: GoogleRequestEvent) => Promise<void>) {
        super({ raiseError: true });
    }

    override async handleCustomEvent(eventName: string, data: unknown): Promise<void> {
        if (!eventName.startsWith(GOOGLE_REQUEST_EVENT_PREFIX) || !isGoogleRequestEvent(data)) return;
        await this.onRequest(data);
    }
}

/**
 * Per-invocation state of the guard. Counts the first request that reaches it and reuses that count
 * for every later call of the invocation. Main and fallback models are counted with the first
 * model's tokenizer, which is accurate enough for a budget.
 */
class InputTokenBudgetCheck implements IInputTokenBudgetCheck {
    /** The in-flight or settled count, or null before the first request or after a failed count. */
    private count: Promise<number | null> | null = null;

    constructor(
        private readonly counter: ITokenCounter,
        private readonly maxInputTokens: number,
        private readonly logger: Logger,
    ) {}

    handlerFor(key: GeminiApiKey): BaseCallbackHandler {
        return new InputTokenBudgetCallbackHandler(this.enforce.bind(this, key));
    }

    /**
     * Throws when the invocation's input exceeds the budget. Concurrent calls (parallel fallback
     * execution) share one in-flight count.
     *
     * @throws {InputTokenBudgetExceededError} when the counted input exceeds the budget
     */
    private async enforce(key: GeminiApiKey, event: GoogleRequestEvent): Promise<void> {
        const pending = this.count ?? this.countInput(key, event);
        this.count = pending;
        const inputTokens = await pending;

        if (inputTokens === null) {
            // Forget the failed count so the next attempt (usually on another key) counts again
            if (this.count === pending) this.count = null;
            return;
        }
        if (inputTokens > this.maxInputTokens) {
            throw new InputTokenBudgetExceededError(inputTokens, this.maxInputTokens);
        }
    }

    /**
     * Counts the request's input tokens inside a Sentry span that records the added latency.
     * Fails open: a count that fails is logged and yields null, so the model call goes ahead
     * unchecked rather than failing over the guard itself.
     */
    private async countInput(key: GeminiApiKey, event: GoogleRequestEvent): Promise<number | null> {
        const model = modelFromUrl(event.url);
        if (model === null) {
            this.logger.warn({ url: event.url }, "Could not read the model from the request URL; skipping token count");
            return null;
        }

        try {
            return await Sentry.startSpan(
                {
                    name: "Count input tokens",
                    op: "llm.count_tokens",
                    attributes: { "llm.model": model, "llm.max_input_tokens": this.maxInputTokens },
                },
                async (span) => {
                    const inputTokens = await this.counter.countTokens({
                        model,
                        apiKey: key.apiKey,
                        request: event.body,
                    });
                    span.setAttributes({
                        "llm.input_tokens": inputTokens,
                        "llm.input_budget_exceeded": inputTokens > this.maxInputTokens,
                    });
                    return inputTokens;
                },
            );
        } catch (err) {
            this.logger.warn(
                { err, model, apiKeyId: key.id },
                "Failed to count input tokens; the model call proceeds without the budget check",
            );
            return null;
        }
    }
}

/**
 * Rejects model calls whose input exceeds `maxInputTokens`, counted by the provider's tokenizer
 * right before the request is sent (after media normalization, so attachments count as sent).
 *
 * A single long-lived instance serves concurrent invocations: it holds only configuration, while
 * per-invocation state lives in the check returned by {@link forRequest}.
 */
export class InputTokenBudgetGuard implements IInputTokenBudgetGuard {
    /**
     * @param counter        - Counts a request's input tokens
     * @param maxInputTokens - Largest allowed input, in tokens
     * @param logger         - Logs counts that fail and let the call through unchecked
     */
    constructor(
        private readonly counter: ITokenCounter,
        private readonly maxInputTokens: number,
        private readonly logger: Logger,
    ) {}

    forRequest(): IInputTokenBudgetCheck {
        return new InputTokenBudgetCheck(this.counter, this.maxInputTokens, this.logger);
    }
}
