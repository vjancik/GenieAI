import { load } from "@langchain/core/load";
import type { BaseMessage } from "@langchain/core/messages";
import {
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import type { DiscordMessage } from "../../domain/message/Message.ts";
import type { Logger } from "../logging/logger.ts";
import {
    GENERAL_SYSTEM_PROMPT,
    type GeneralModel,
} from "./agents/generalAgent.ts";
import {
    SEARCH_SYSTEM_PROMPT,
    type SearchModel,
} from "./agents/searchAgent.ts";
import type { TriageModel } from "./agents/triageAgent.ts";
import { TRIAGE_SYSTEM_PROMPT } from "./agents/triageAgent.ts";
import type { GetVideoTranscriptionTool } from "./tools/getVideoTranscriptionTool.ts";
import type { GetWebsiteTool } from "./tools/getWebsiteTool.ts";

/**
 * Converts persisted {@link DiscordMessage} records into LangChain {@link BaseMessage} objects.
 *
 * Each DiscordMessage can contain multiple serialized LangChain messages
 * (e.g. a bot turn with tool use stores [triageAIMessage, ToolMessage, finalAIMessage]).
 * All messages are deserialized via load() and flattened into a single chronological array.
 *
 * @param records - Chronologically ordered DB message records
 */
export async function dbMessagesToLangchain(
    records: DiscordMessage[],
): Promise<BaseMessage[]> {
    const nested = await Promise.all(
        records.map((r) =>
            Promise.all(
                r.langchainMessages.map(
                    // load() expects a JSON string; JSON.stringify round-trips the parsed object
                    // TODO: I hate this, let's do better
                    (json) =>
                        load(JSON.stringify(json)) as Promise<BaseMessage>,
                ),
            ),
        ),
    );
    return nested.flat();
}

/**
 * Extracts the displayable text content from a model response, handling both
 * string and structured array formats. Filters out Gemini thought chunks
 * (internal reasoning marked with thought: true) which should not be shown to users,
 * while preserving them in the stored message for context continuity.
 */
function extractContent(response: BaseMessage): string {
    if (typeof response.content === "string") {
        return response.content;
    }
    // For structured content arrays, join all non-thought text parts
    return response.content
        .filter(
            (part) =>
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                // Exclude Gemini thought chunks (internal reasoning, not display content)
                !("thought" in part && (part as { thought?: boolean }).thought),
        )
        .map((part) => (part as { type: "text"; text: string }).text)
        .join("");
}

/** Result of a single LLM invocation: display content + all generated messages to persist. */
interface InvokeResult {
    content: string;
    messages: BaseMessage[];
}

/**
 * Orchestrates the multi-agent triage routing pipeline.
 *
 * Flow:
 * 1. Invoke the triage model (single pass) to classify the request
 * 2. Inspect which tool was called
 * 3a. get_website / get_video_transcription → execute the tool, pass results to general model
 * 3b. route_to_search → invoke the search model (with grounding)
 * 3c. route_to_general / no tool → invoke the general model directly
 */
export class Orchestrator {
    constructor(
        private readonly triageModel: TriageModel,
        private readonly generalModel: GeneralModel,
        private readonly searchModel: SearchModel,
        private readonly getWebsiteTool: GetWebsiteTool,
        private readonly getVideoTranscriptionTool: GetVideoTranscriptionTool,
        private readonly logger: Logger,
    ) {}

    /**
     * Process a user message with conversation history.
     *
     * Returns the display content string and all new LangChain messages generated
     * during processing (for persistence). The newMessages array includes intermediate
     * messages (triage response, tool messages) so history has no gaps.
     *
     * @param history - Prior messages in the reply chain, chronologically ordered
     * @param userMessage - The current user's message text
     */
    async process(
        history: BaseMessage[],
        userMessage: string,
    ): Promise<{ content: string; newMessages: BaseMessage[] }> {
        const messages: BaseMessage[] = [
            new SystemMessage(TRIAGE_SYSTEM_PROMPT),
            ...history,
            new HumanMessage(userMessage),
        ];

        // Single-pass triage: one LLM call to classify the request
        const triageResponse = await this.triageModel.invoke(messages);
        const toolCalls = triageResponse.tool_calls ?? [];

        if (toolCalls.length === 0) {
            // No tool selected — fall through to general agent
            this.logger.info(
                "Triage made no tool call, routing to general agent",
            );
            const result = await this.invokeGeneral([
                ...history,
                new HumanMessage(userMessage),
            ]);
            return { content: result.content, newMessages: result.messages };
        }

        // toolCalls.length > 0 is guaranteed by the guard above
        const toolCall = toolCalls[0];
        if (!toolCall) {
            const result = await this.invokeGeneral([
                ...history,
                new HumanMessage(userMessage),
            ]);
            return { content: result.content, newMessages: result.messages };
        }
        this.logger.info({ toolName: toolCall.name }, "Triage selected route");

        switch (toolCall.name) {
            case "get_website": {
                const toolResult = await this.getWebsiteTool.invoke(
                    toolCall.args as { urls: string[] },
                );
                const result = await this.invokeGeneralWithToolResult(
                    history,
                    userMessage,
                    triageResponse,
                    toolCall.id ?? "",
                    toolResult,
                );
                return {
                    content: result.content,
                    newMessages: result.messages,
                };
            }
            case "get_video_transcription": {
                const toolResult = await this.getVideoTranscriptionTool.invoke(
                    toolCall.args as { urls: string[] },
                );
                const result = await this.invokeGeneralWithToolResult(
                    history,
                    userMessage,
                    triageResponse,
                    toolCall.id ?? "",
                    toolResult,
                );
                return {
                    content: result.content,
                    newMessages: result.messages,
                };
            }
            case "route_to_search": {
                const result = await this.invokeSearch([
                    ...history,
                    new HumanMessage(userMessage),
                ]);
                return {
                    content: result.content,
                    newMessages: result.messages,
                };
            }
            case "route_to_general": {
                const result = await this.invokeGeneral([
                    ...history,
                    new HumanMessage(userMessage),
                ]);
                return {
                    content: result.content,
                    newMessages: result.messages,
                };
            }
            default: {
                this.logger.warn(
                    { toolName: toolCall.name },
                    "Unknown triage tool, falling back to general",
                );
                const result = await this.invokeGeneral([
                    ...history,
                    new HumanMessage(userMessage),
                ]);
                return {
                    content: result.content,
                    newMessages: result.messages,
                };
            }
        }
    }

    /**
     * Passes the triage conversation (including the tool result) to the stronger general model
     * so it can formulate the final answer based on the retrieved content.
     *
     * The message sequence sent to the general model is:
     *   [history...] → [human msg] → [triage AI msg with tool call] → [tool result] → [instruction]
     *
     * All three generated messages (triageAIMessage, ToolMessage, finalAIMessage) are returned
     * for persistence so the full tool-use context is preserved in history.
     */
    private async invokeGeneralWithToolResult(
        history: BaseMessage[],
        userMessage: string,
        triageAiMessage: BaseMessage,
        toolCallId: string,
        toolResult: string,
    ): Promise<InvokeResult> {
        const toolMessage = new ToolMessage({
            content: toolResult,
            tool_call_id: toolCallId,
        });
        const messagesWithResult: BaseMessage[] = [
            new SystemMessage(GENERAL_SYSTEM_PROMPT),
            ...history,
            new HumanMessage(userMessage),
            triageAiMessage,
            toolMessage,
            new HumanMessage(
                "Based on the retrieved content above, please answer the original question. " +
                    "Keep your response under 1500 characters.",
            ),
        ];

        const response = await this.generalModel.invoke(messagesWithResult);
        return {
            content: extractContent(response),
            // triageAiMessage contains the tool_call that makes toolMessage valid context
            messages: [triageAiMessage, toolMessage, response],
        };
    }

    private async invokeGeneral(
        messages: BaseMessage[],
    ): Promise<InvokeResult> {
        const response = await this.generalModel.invoke([
            new SystemMessage(GENERAL_SYSTEM_PROMPT),
            ...messages,
        ]);
        return { content: extractContent(response), messages: [response] };
    }

    private async invokeSearch(messages: BaseMessage[]): Promise<InvokeResult> {
        const response = await this.searchModel.invoke([
            new SystemMessage(SEARCH_SYSTEM_PROMPT),
            ...messages,
        ]);
        return { content: extractContent(response), messages: [response] };
    }
}
