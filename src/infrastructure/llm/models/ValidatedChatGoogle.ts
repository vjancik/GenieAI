import { ChatGoogle } from "@langchain/google/node";

/**
 * Gemini's `VALIDATED` function-calling mode.
 *
 * `allowedFunctionNames` is deliberately omitted — it only matters when restricting
 * the model to a subset of the declared functions, which none of our call sites need.
 */
const VALIDATED_TOOL_CONFIG = {
    functionCallingConfig: { mode: "VALIDATED" },
} as const;

/**
 * A {@link ChatGoogle} variant that forces Gemini's `VALIDATED` function-calling
 * mode on every request, regardless of which tools or `tool_choice` are bound.
 *
 * `@langchain/google` cannot express this mode. Its `tool_choice` converter maps
 * only `"auto" | "any" | "required" | "none"`, and treats any other string as a
 * *function name* — emitting `mode: "ANY"` with `allowedFunctionNames: [<string>]`,
 * which the API rejects when no function of that name is declared. `VALIDATED`
 * appears in the library's wire types but is unreachable through its public API,
 * so the only way in is to rewrite `toolConfig` after the base class has built it.
 *
 * Because the config is applied unconditionally, this also sidesteps the upstream
 * bug where `toolConfig` is dropped entirely when the bound tools array is empty.
 *
 * @see https://github.com/langchain-ai/langchainjs/issues/10432
 */
export class ValidatedChatGoogle extends ChatGoogle {
    /** Replaces the `tool_choice`-derived `toolConfig` with an unconditional `VALIDATED` mode. */
    override invocationParams(options: this["ParsedCallOptions"]) {
        return { ...super.invocationParams(options), toolConfig: VALIDATED_TOOL_CONFIG };
    }
}
