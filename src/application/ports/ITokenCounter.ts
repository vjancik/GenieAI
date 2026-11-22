/** A model request whose input tokens are to be counted. */
export interface TokenCountRequest {
    /** Name of the model the request targets (e.g. "gemini-3.5-flash"); tokenization is model-specific. */
    model: string;
    /** API key to authenticate the count with. */
    apiKey: string;
    /**
     * The generate-content request body exactly as it would be sent to the provider: contents,
     * system instruction, tools and generation settings. Everything in it counts toward the total.
     */
    request: Readonly<Record<string, unknown>>;
}

/** Port for counting a model request's input tokens with the provider's own tokenizer. */
export interface ITokenCounter {
    /**
     * Returns the total number of input tokens of `request`.
     *
     * @throws {TokenCountError} when the provider rejects the count or answers with a malformed body
     */
    countTokens(request: TokenCountRequest): Promise<number>;
}
