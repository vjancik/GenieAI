/**
 * Returns true if the error is the `@langchain/google` `PromptBlockedError`, thrown when the Gemini
 * API refuses to process a prompt and reports a `promptFeedback.blockReason`.
 *
 * Matched structurally on its name and `blockReason` field because the package does not export
 * the class.
 */
export function isPromptBlockedError(err: unknown): err is Error & { blockReason: unknown } {
    return err instanceof Error && err.name === "PromptBlockedError" && "blockReason" in err;
}
