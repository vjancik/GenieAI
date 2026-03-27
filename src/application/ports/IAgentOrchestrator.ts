import type { BaseMessage } from "@langchain/core/messages";
import type { PersistedChatMessage } from "../../domain/message/Message.ts";
import type { MessageIntent } from "../../domain/message/MessageIntent.ts";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";

/**
 * Port for the LLM orchestration layer.
 *
 * Defines the contract the application use case depends on, keeping it decoupled
 * from the concrete LangGraph/LangChain implementation in infrastructure.
 */
export interface IAgentOrchestrator {
    /**
     * Deserializes persisted {@link PersistedChatMessage} records into LangChain
     * {@link BaseMessage} objects suitable for passing as conversation history.
     *
     * @param records - Chronologically ordered DB message records
     * @returns Flat array of deserialized LangChain messages
     */
    buildHistory(records: PersistedChatMessage[]): BaseMessage[];

    /**
     * Process a sequence of messages through the agent pipeline.
     *
     * @param messages - Full message sequence ending with a HumanMessage (history + current user turn).
     *   The last message MUST be a HumanMessage — an Error is thrown otherwise.
     * @param intent - The user's declared intent, used to bypass triage for explicit commands
     * @param onStatusUpdate - Optional callback invoked as the agent transitions between phases
     * @returns The display content string and all new LangChain messages generated during processing
     */
    process(
        messages: BaseMessage[],
        intent: MessageIntent,
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<{ content: string; newMessages: BaseMessage[]; isRetryable: boolean; usedFallback: boolean }>;
}
