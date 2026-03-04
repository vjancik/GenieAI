import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
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
 * Single text-only messages use a plain string content for simplicity.
 * Multi-chunk or non-text messages use the structured array format for multimodal support.
 *
 * @param records - Chronologically ordered DB message records
 */
export function dbMessagesToLangchain(
    records: DiscordMessage[],
): BaseMessage[] {
    return records.map((r) => {
        // Use plain string content for single-text-chunk messages (most common case)
        const content =
            r.contentChunks.length === 1 && r.contentChunks[0]?.type === "text"
                ? r.contentChunks[0].text
                : r.contentChunks;

        if (r.role === "human") {
            return new HumanMessage(content as string);
        }
        return new AIMessage(content as string);
    });
}

/**
 * Extracts the text content from a model response, handling both string and array formats.
 */
function extractContent(response: BaseMessage): string {
    if (typeof response.content === "string") {
        return response.content;
    }
    // For structured content arrays, join all text parts
    return response.content
        .filter(
            (part) =>
                typeof part === "object" &&
                "type" in part &&
                part.type === "text",
        )
        .map((part) => (part as { type: "text"; text: string }).text)
        .join("");
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
     * Process a user message with conversation history, returning the AI response string.
     *
     * @param history - Prior messages in the reply chain, chronologically ordered
     * @param userMessage - The current user's message text
     */
    async process(
        history: BaseMessage[],
        userMessage: string,
    ): Promise<string> {
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
            return this.invokeGeneral([
                ...history,
                new HumanMessage(userMessage),
            ]);
        }

        // toolCalls.length > 0 is guaranteed by the guard above
        const toolCall = toolCalls[0];
        if (!toolCall) {
            return this.invokeGeneral([
                ...history,
                new HumanMessage(userMessage),
            ]);
        }
        this.logger.info({ toolName: toolCall.name }, "Triage selected route");

        switch (toolCall.name) {
            case "get_website": {
                const result = await this.getWebsiteTool.invoke(
                    toolCall.args as { urls: string[] },
                );
                return this.invokeGeneralWithToolResult(
                    history,
                    userMessage,
                    triageResponse,
                    toolCall.id ?? "",
                    result,
                );
            }
            case "get_video_transcription": {
                const result = await this.getVideoTranscriptionTool.invoke(
                    toolCall.args as { urls: string[] },
                );
                return this.invokeGeneralWithToolResult(
                    history,
                    userMessage,
                    triageResponse,
                    toolCall.id ?? "",
                    result,
                );
            }
            case "route_to_search":
                return this.invokeSearch([
                    ...history,
                    new HumanMessage(userMessage),
                ]);
            case "route_to_general":
                return this.invokeGeneral([
                    ...history,
                    new HumanMessage(userMessage),
                ]);
            default:
                this.logger.warn(
                    { toolName: toolCall.name },
                    "Unknown triage tool, falling back to general",
                );
                return this.invokeGeneral([
                    ...history,
                    new HumanMessage(userMessage),
                ]);
        }
    }

    /**
     * Passes the triage conversation (including the tool result) to the stronger general model
     * so it can formulate the final answer based on the retrieved content.
     *
     * The message sequence sent to the general model is:
     *   [history...] → [human msg] → [triage AI msg with tool call] → [tool result] → [instruction]
     */
    private async invokeGeneralWithToolResult(
        history: BaseMessage[],
        userMessage: string,
        triageAiMessage: BaseMessage,
        toolCallId: string,
        toolResult: string,
    ): Promise<string> {
        const messagesWithResult: BaseMessage[] = [
            new SystemMessage(GENERAL_SYSTEM_PROMPT),
            ...history,
            new HumanMessage(userMessage),
            triageAiMessage,
            new ToolMessage({
                content: toolResult,
                tool_call_id: toolCallId,
            }),
            new HumanMessage(
                "Based on the retrieved content above, please answer the original question. " +
                    "Keep your response under 1500 characters.",
            ),
        ];

        const response = await this.generalModel.invoke(messagesWithResult);
        return extractContent(response);
    }

    private async invokeGeneral(messages: BaseMessage[]): Promise<string> {
        const response = await this.generalModel.invoke([
            new SystemMessage(GENERAL_SYSTEM_PROMPT),
            ...messages,
        ]);
        return extractContent(response);
    }

    private async invokeSearch(messages: BaseMessage[]): Promise<string> {
        const response = await this.searchModel.invoke([
            new SystemMessage(SEARCH_SYSTEM_PROMPT),
            ...messages,
        ]);
        return extractContent(response);
    }
}
