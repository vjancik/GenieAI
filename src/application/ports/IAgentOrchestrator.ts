import type { BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { DiscordMessage } from "../../domain/message/Message.ts";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";
import type { IDiscordAttachmentRefetcher } from "./IDiscordAttachmentRefetcher.ts";

/**
 * Port for the LLM orchestration layer.
 *
 * Defines the contract the application use case depends on, keeping it decoupled
 * from the concrete LangGraph/LangChain implementation in infrastructure.
 */
export interface IAgentOrchestrator {
    /**
     * Deserializes persisted {@link DiscordMessage} records into LangChain
     * {@link BaseMessage} objects suitable for passing as conversation history.
     *
     * @param records - Chronologically ordered DB message records
     * @returns Flat array of deserialized LangChain messages
     */
    buildHistory(records: DiscordMessage[]): BaseMessage[];

    /**
     * Process a user message with conversation history through the agent pipeline.
     *
     * @param history - Prior messages in the reply chain, chronologically ordered
     * @param userMessage - The current user's HumanMessage
     * @param onStatusUpdate - Optional callback invoked as the agent transitions between phases
     * @returns The display content string and all new LangChain messages generated during processing
     */
    process(
        history: BaseMessage[],
        userMessage: HumanMessage,
        onStatusUpdate?: OnStatusUpdate,
        attachmentRefetcher?: IDiscordAttachmentRefetcher,
    ): Promise<{ content: string; newMessages: BaseMessage[] }>;
}
