import { tool } from "@langchain/core/tools";

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
