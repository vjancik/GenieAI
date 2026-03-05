import { load } from "@langchain/core/load";
import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import {
    Command,
    END,
    MessagesAnnotation,
    START,
    StateGraph,
} from "@langchain/langgraph";
import { AppError } from "../../domain/errors/AppError.ts";
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

/** Graph state type from MessagesAnnotation */
type GraphState = typeof MessagesAnnotation.State;

/**
 * Orchestrates the multi-agent triage routing pipeline as a LangGraph StateGraph.
 *
 * Graph topology:
 *   START → triage → executeTool → general → END
 *                  ↘ general → END
 *                  ↘ search  → END
 *
 * Routing decisions are made in the triage node via Command.goto.
 * Routing-only tool calls (route_to_search, route_to_general) are NOT added
 * to the messages state, preventing context bloat in subsequent turns.
 * Real tool calls (get_website, get_video_transcription) DO add their triage
 * AIMessage to state because it is required for the ToolMessage to be valid context.
 */
export class Orchestrator {
    // Type inferred from buildGraph() return — avoids complex LangGraph generic annotation
    // biome-ignore lint/suspicious/noExplicitAny: LangGraph compiled graph generic is impractical to annotate
    private readonly graph: ReturnType<() => any>;

    constructor(
        private readonly triageModel: TriageModel,
        private readonly generalModel: GeneralModel,
        private readonly searchModel: SearchModel,
        private readonly getWebsiteTool: GetWebsiteTool,
        private readonly getVideoTranscriptionTool: GetVideoTranscriptionTool,
        private readonly logger: Logger,
    ) {
        this.graph = this.buildGraph();
    }

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
        const initialMessages = [...history, new HumanMessage(userMessage)];
        const result = (await this.graph.invoke({
            messages: initialMessages,
        })) as { messages: BaseMessage[] };

        // Everything after the initial seed is "new" — generated during this turn
        const newMessages = result.messages.slice(initialMessages.length);
        const lastMessage = result.messages.at(-1);
        if (!lastMessage) {
            throw new AppError(
                "ORCHESTRATOR_NO_RESPONSE",
                "Graph produced no messages",
            );
        }

        return { content: extractContent(lastMessage), newMessages };
    }

    /**
     * Compiles the LangGraph StateGraph. Called once in the constructor.
     *
     * The triage node uses Command.goto for dynamic routing without conditional edges.
     * Routing sentinel calls (route_to_search / route_to_general) are consumed here
     * without being added to graph state — they are invisible in persisted history.
     */
    private buildGraph() {
        return new StateGraph(MessagesAnnotation)
            .addNode("triage", (state: GraphState) => this.triageNode(state), {
                ends: ["executeTool", "general", "search"],
            })
            .addNode("executeTool", (state: GraphState) =>
                this.executeToolNode(state),
            )
            .addNode("general", (state: GraphState) => this.generalNode(state))
            .addNode("search", (state: GraphState) => this.searchNode(state))
            .addEdge(START, "triage")
            .addEdge("executeTool", "general")
            .addEdge("general", END)
            .addEdge("search", END)
            .compile();
    }

    /**
     * Triage node: classifies the request via a single model call and routes accordingly.
     *
     * Returns a Command that both updates state (adding the triage AIMessage only for
     * real tool calls) and routes to the correct next node.
     *
     * Routing sentinels (route_to_search / route_to_general) are intentionally NOT added
     * to messages state to prevent context bloat in future turns.
     */
    private async triageNode(state: GraphState): Promise<Command> {
        const messages: BaseMessage[] = [
            new SystemMessage(TRIAGE_SYSTEM_PROMPT),
            ...state.messages,
        ];

        const triageResponse = await this.triageModel.invoke(messages);
        const toolCall = (triageResponse as AIMessage).tool_calls?.[0];

        if (!toolCall) {
            this.logger.info(
                "Triage made no tool call, routing to general agent",
            );
            return new Command({ goto: "general" });
        }

        this.logger.info({ toolName: toolCall.name }, "Triage selected route");

        switch (toolCall.name) {
            case "get_website":
            case "get_video_transcription":
                // Real tool call: add triage AIMessage to state so the ToolMessage
                // created in executeToolNode has a valid tool_call_id in history
                return new Command({
                    goto: "executeTool",
                    update: { messages: [triageResponse] },
                });

            case "route_to_search":
                // Routing sentinel: do NOT add triage message to state
                return new Command({ goto: "search" });

            case "route_to_general":
                // Routing sentinel: do NOT add triage message to state
                return new Command({ goto: "general" });

            default:
                this.logger.warn(
                    { toolName: toolCall.name },
                    "Unknown triage tool, falling back to general",
                );
                return new Command({ goto: "general" });
        }
    }

    /**
     * Execute tool node: runs the content tool whose call was placed in state by triageNode.
     *
     * Reads the last message (the triage AIMessage with tool_calls) to determine which
     * tool to run and with what arguments. Always routes to the general node via static edge.
     */
    private async executeToolNode(
        state: GraphState,
    ): Promise<{ messages: BaseMessage[] }> {
        const lastMsg = state.messages.at(-1);
        const toolCall =
            lastMsg instanceof AIMessage ? lastMsg.tool_calls?.[0] : undefined;

        if (!toolCall) {
            throw new AppError(
                "ORCHESTRATOR_MISSING_TOOL_CALL",
                "executeToolNode reached without a tool call in state",
            );
        }

        let toolResult: string;
        if (toolCall.name === "get_website") {
            toolResult = await this.getWebsiteTool.invoke(
                toolCall.args as { urls: string[] },
            );
        } else {
            toolResult = await this.getVideoTranscriptionTool.invoke(
                toolCall.args as { urls: string[] },
            );
        }

        const toolMessage = new ToolMessage({
            content: toolResult,
            tool_call_id: toolCall.id ?? "",
        });

        return { messages: [toolMessage] };
    }

    /**
     * General agent node: generates the final answer using the general-purpose model.
     *
     * When the last state message is a ToolMessage (content tool path), appends an
     * instruction prompt to focus the model on the retrieved content. This extra
     * HumanMessage is passed transiently to the model and is NOT stored in state.
     */
    private async generalNode(
        state: GraphState,
    ): Promise<{ messages: BaseMessage[] }> {
        const lastMsg = state.messages.at(-1);
        const hasToolResult = lastMsg instanceof ToolMessage;

        const invokeMessages: BaseMessage[] = [
            new SystemMessage(GENERAL_SYSTEM_PROMPT),
            ...state.messages,
        ];

        if (hasToolResult) {
            // Transient instruction: not added to state, only to the invoke call
            invokeMessages.push(
                new HumanMessage(
                    "Based on the retrieved content above, please answer the original question. " +
                        "Keep your response under 1500 characters.",
                ),
            );
        }

        const response = await this.generalModel.invoke(invokeMessages);
        return { messages: [response] };
    }

    /**
     * Search agent node: generates an answer using the Google-Search-grounded model.
     */
    private async searchNode(
        state: GraphState,
    ): Promise<{ messages: BaseMessage[] }> {
        const response = await this.searchModel.invoke([
            new SystemMessage(SEARCH_SYSTEM_PROMPT),
            ...state.messages,
        ]);
        return { messages: [response] };
    }
}
