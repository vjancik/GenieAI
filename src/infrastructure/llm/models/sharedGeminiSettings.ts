import { tool } from "@langchain/core/tools";

/**
 * Disables `@langchain/google`'s own retry loop on every model we build.
 *
 * Since 0.2.x the library wraps its request in `AsyncCaller.callWithOptions`, which
 * retries up to 6 times with exponential backoff by default. `ResilientModelInvoker`
 * already owns that policy — it rotates API keys on 429 and falls back to the
 * secondary model on 503/timeout — so leaving the library default in place would
 * nest the two loops: a 503 would burn six backed-off retries against the failing
 * model before our fallback ever sees the error.
 *
 * @see https://github.com/langchain-ai/langchainjs/pull/11342
 */
export const noInternalRetries = 0;

/**
 * A placeholder tool passed to `bindTools` to work around a LangChain bug where
 * `tool_choice: "none"` is ignored when the tools array is empty.
 * See: https://github.com/langchain-ai/langchainjs/issues/10432
 */
export const neverTool = tool(() => "", {
    name: "never_call_tools_or_functions",
    description: "If you read this tool / function description, YOU MUST NOT CALL ANY TOOLS OR FUNCTIONS.",
});

/**
 * Safety settings that only block high-confidence harmful content across every Gemini harm category.
 * Apply these as a sensible default that reduces egregious outputs while minimising false-positive blocks.
 *
 * - `HARM_CATEGORY_HARASSMENT`        – Harassment content.
 * - `HARM_CATEGORY_HATE_SPEECH`       – Hate speech and content.
 * - `HARM_CATEGORY_SEXUALLY_EXPLICIT` – Sexually explicit content.
 * - `HARM_CATEGORY_DANGEROUS_CONTENT` – Dangerous content.
 */
export const blockHighSafetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

/**
 * Safety settings that disable all content blocking across every Gemini harm category.
 * Apply these when the bot's moderation layer handles filtering externally, or
 * when the default thresholds produce too many false-positive blocks.
 */
export const blockNoneSafetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];
