import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
    ChatMessage,
    FunctionMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google";
import {
    Command,
    END,
    MessagesAnnotation,
    START,
    StateGraph,
} from "@langchain/langgraph";
import { z } from "zod/v4";
import type { IAgentOrchestrator } from "../../application/ports/IAgentOrchestrator.ts";
import type { OnStatusUpdate } from "../../application/types/AgentStatus.ts";
import { AgentStatusType } from "../../application/types/AgentStatus.ts";
import type { Logger } from "../../application/types/Logger.ts";
import { AppError } from "../../domain/errors/AppError.ts";
import type { DiscordMessage } from "../../domain/message/Message.ts";
import type { AppConfig } from "../config/config.ts";
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
import { filterHistoryForInlineSize } from "./inlineAttachmentFilter.ts";
import type { GetVideoTranscriptionTool } from "./tools/getVideoTranscriptionTool.ts";
import type { GetWebsiteTool } from "./tools/getWebsiteTool.ts";

/**
 * Zod schema for the LangGraph runtime context passed to each node.
 * Lives in context (not state) so it is never serialized by a checkpointer.
 */
const OrchestratorContextSchema = z.object({
    onStatusUpdate: z.custom<OnStatusUpdate>().optional(),
});

type OrchestratorContext = z.infer<typeof OrchestratorContextSchema>;

/**
 * Config shape received by each node. LangGraph types `context` as potentially
 * undefined even when a schema is provided, so it is optional here. The bound
 * node functions always receive a config object, so `config` itself is non-optional.
 */
type NodeConfig = { context?: OrchestratorContext };

/**
 * Returns a copy of the serialized message JSON with thought: true content parts removed.
 * Only modifies messages whose kwargs.content is an array (structured content).
 * String content messages pass through unchanged.
 */
function stripThoughtChunks(
    json: Record<string, unknown>,
): Record<string, unknown> {
    // TYPE COERCION: json.kwargs is unknown in the generic record; cast to the known LangChain
    // serialization shape (kwargs is always a record of named constructor arguments).
    const kwargs = json.kwargs as Record<string, unknown> | undefined;
    if (!Array.isArray(kwargs?.content)) return json;
    return {
        ...json,
        kwargs: {
            ...kwargs,
            // TYPE COERCION: kwargs.content is unknown after the Array.isArray check;
            // each element is a structured content part (object with at least a type field).
            content: (kwargs.content as Record<string, unknown>[]).filter(
                // TODO: this should be it's own predicate function somewhere else
                (part) =>
                    !(
                        typeof part === "object" &&
                        part !== null &&
                        part.thought === true
                    ),
            ),
        },
    };
}

/**
 * Reconstructs a LangChain {@link BaseMessage} from a stored `.toJSON()` object.
 * Dispatches on the last element of the `id` array to select the correct constructor.
 *
 * - {@link SystemMessage} in history is a programmatic error (they are injected dynamically,
 *   not stored). Logs an error and throws in non-production environments.
 * - {@link ChatMessage}, {@link FunctionMessage}, {@link RemoveMessage} are unexpected but
 *   valid — logged as warnings and reconstructed.
 * - Completely unknown types log a warning and throw an {@link AppError}.
 */
function deserializeMessage(
    json: Record<string, unknown>,
    logger: Logger,
): BaseMessage {
    // TYPE COERCION: json.id is unknown; per LangChain's serialization format it is a string[]
    // representing the module path (e.g. ["langchain_core", "messages", "HumanMessage"]).
    const className = (json.id as string[]).at(-1);
    // TYPE COERCION: json.kwargs is unknown; it is always a Record of named constructor
    // arguments in LangChain's serialization format.
    const kwargs = json.kwargs as Record<string, unknown>;

    switch (className) {
        case "HumanMessage":
            return new HumanMessage(kwargs);
        case "AIMessage":
            return new AIMessage(kwargs);
        case "ToolMessage":
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ToolMessage's strict constructor union type; double cast through unknown is required.
            return new ToolMessage(
                kwargs as unknown as ConstructorParameters<
                    typeof ToolMessage
                >[0],
            );
        case "ChatMessage":
            logger.warn(
                { className },
                "Unexpected message type in history chain",
            );
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ChatMessage's strict constructor union type; double cast through unknown is required.
            return new ChatMessage(
                kwargs as unknown as ConstructorParameters<
                    typeof ChatMessage
                >[0],
            );
        case "FunctionMessage":
            logger.warn(
                { className },
                "Unexpected message type in history chain",
            );
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // FunctionMessage's strict constructor union type; double cast through unknown is required.
            return new FunctionMessage(
                kwargs as unknown as ConstructorParameters<
                    typeof FunctionMessage
                >[0],
            );
        case "RemoveMessage":
            logger.warn(
                { className },
                "Unexpected message type in history chain",
            );
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // RemoveMessage's strict constructor union type; double cast through unknown is required.
            return new RemoveMessage(
                kwargs as unknown as ConstructorParameters<
                    typeof RemoveMessage
                >[0],
            );
        case "SystemMessage": {
            logger.error(
                { className },
                "SystemMessage found in stored history — this is a programmatic error; SystemMessages should be injected dynamically, not persisted",
            );
            if (process.env.NODE_ENV !== "production") {
                throw new AppError(
                    "INVALID_STORED_MESSAGE_TYPE",
                    "SystemMessage must not be stored in history — inject it dynamically instead",
                );
            }
            return new SystemMessage(kwargs);
        }
        default:
            logger.warn({ className }, "Unknown message type in history chain");
            throw new AppError(
                "UNKNOWN_MESSAGE_TYPE",
                `Cannot deserialize unknown message type: ${className}`,
            );
    }
}

/**
 * Converts persisted {@link DiscordMessage} records into LangChain {@link BaseMessage} objects.
 *
 * Each DiscordMessage can contain multiple serialized LangChain messages
 * (e.g. a bot turn with tool use stores [triageAIMessage, ToolMessage, finalAIMessage]).
 * All messages are deserialized by dispatching on the serialized class name and flattened
 * into a single chronological array.
 *
 * Optionally strips thought chunks (thought: true) from content arrays before construction,
 * reducing LLM request size. Gemini uses thoughtSignatures for context continuity, not the
 * thought text itself, so stripping is safe.
 *
 * @param records - Chronologically ordered DB message records
 * @param logger - Logger for warnings/errors on unexpected message types
 * @param filterThoughtChunks - Strip thought: true content parts before reconstruction (default: true)
 */
export function dbMessagesToLangchain(
    records: DiscordMessage[],
    logger: Logger,
    filterThoughtChunks = true,
): BaseMessage[] {
    return records.flatMap((r) =>
        r.langchainMessages.map((json) => {
            const prepared = filterThoughtChunks
                ? stripThoughtChunks(json)
                : json;
            return deserializeMessage(prepared, logger);
        }),
    );
}

/** A structured content part that is a plain text segment. */
type TextContentPart = { type: "text"; text: string };

/**
 * Type guard: returns true if a content array element is a visible text part.
 *
 * Excludes Gemini thought chunks (`thought: true`), which are internal reasoning
 * that should be preserved in storage but never shown to users.
 */
function isVisibleTextPart(part: unknown): part is TextContentPart {
    if (typeof part !== "object" || part === null) return false;
    // TYPE COERCION: part is narrowed to object but object doesn't allow index access;
    // cast to Record to read structured content fields by name.
    const p = part as Record<string, unknown>;
    if (p.type !== "text" || typeof p.text !== "string") return false;
    // Exclude Gemini thought chunks (thought: true marks internal reasoning)
    return p.thought !== true;
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
        .filter(isVisibleTextPart)
        .map((part) => part.text)
        .join("");
}

/** Graph state type from MessagesAnnotation */
type GraphState = typeof MessagesAnnotation.State;

/**
 * Recursively unwraps LangChain Runnable wrappers to reach the base model.
 *
 * LangChain wrapper types hold the underlying runnable under different property names:
 * - `RunnableBinding` (.bindTools(), .withConfig()) → `.bound`
 * - `RunnableRetry` (.withRetry()) → `.bound` (extends RunnableBinding)
 * - `RunnableWithFallbacks` (.withFallbacks()) → `.runnable`
 *
 * The recursion bottoms out when neither property exists, returning the value as-is.
 */
function unwrapRunnable(model: unknown): unknown {
    if (typeof model !== "object" || model === null) return model;
    // TYPE COERCION: model is narrowed to object, but object doesn't support index access;
    // cast to Record to read the .bound / .runnable wrapper properties by name.
    const m = model as Record<string, unknown>;
    if (typeof m.bound === "object" && m.bound !== null)
        return unwrapRunnable(m.bound);
    if (typeof m.runnable === "object" && m.runnable !== null)
        return unwrapRunnable(m.runnable);
    return model;
}

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
export class AgentOrchestrator implements IAgentOrchestrator {
    // Type inferred from buildGraph() return — avoids complex LangGraph generic annotation
    // biome-ignore lint/suspicious/noExplicitAny: LangGraph compiled graph generic is impractical to annotate
    private readonly graph: ReturnType<() => any>;
    /** Pre-computed byte limit for inline attachment filtering (0 = no filtering). */
    private readonly maxInlineBytes: number;
    private readonly attachmentMode: AppConfig["attachmentMode"];

    constructor(
        private readonly triageModel: TriageModel,
        private readonly generalModel: GeneralModel,
        private readonly searchModel: SearchModel,
        private readonly getWebsiteTool: GetWebsiteTool,
        private readonly getVideoTranscriptionTool: GetVideoTranscriptionTool,
        private readonly logger: Logger,
        config: Pick<AppConfig, "attachmentMode" | "maxInlineAttachmentSizeMb">,
    ) {
        // Upload mode uses the Gemini Files API, which is only supported by ChatGoogle.
        // Guard here to catch wiring mistakes early — in production all models are ChatGoogle.
        if (config.attachmentMode === "upload") {
            for (const [name, model] of [
                ["triageModel", triageModel],
                ["generalModel", generalModel],
                ["searchModel", searchModel],
            ] as const) {
                if (!(unwrapRunnable(model) instanceof ChatGoogle)) {
                    throw new Error(
                        `Orchestrator: upload attachment mode requires all models to be ChatGoogle, but "${name}" is not`,
                    );
                }
            }
        }

        this.attachmentMode = config.attachmentMode;
        this.maxInlineBytes = config.maxInlineAttachmentSizeMb * 1024 * 1024;
        this.graph = this.buildGraph();
    }

    /**
     * Deserializes persisted {@link DiscordMessage} records into LangChain messages.
     * Delegates to {@link dbMessagesToLangchain} — see that function for full documentation.
     *
     * Exposed here so the application layer can call it through {@link IAgentOrchestrator}
     * without importing infrastructure utilities directly.
     */
    buildHistory(records: DiscordMessage[]): BaseMessage[] {
        return dbMessagesToLangchain(records, this.logger);
    }

    /**
     * Process a user message with conversation history.
     *
     * Returns the display content string and all new LangChain messages generated
     * during processing (for persistence). The newMessages array includes intermediate
     * messages (triage response, tool messages) so history has no gaps.
     *
     * @param history - Prior messages in the reply chain, chronologically ordered
     * @param userMessage - The current user's HumanMessage (may contain multimodal content blocks)
     * @param onStatusUpdate - Optional callback invoked as the agent transitions between processing phases
     */
    async process(
        history: BaseMessage[],
        userMessage: HumanMessage,
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<{ content: string; newMessages: BaseMessage[] }> {
        const initialMessages = [...history, userMessage];
        // Always pass context so nodes receive a non-optional config; onStatusUpdate may be undefined
        // TYPE COERCION: LangGraph's compiled graph is typed as any (see field declaration);
        // annotate the known output shape — MessagesAnnotation always produces { messages: BaseMessage[] }.
        const result = (await this.graph.invoke(
            { messages: initialMessages },
            { context: { onStatusUpdate } },
        )) as { messages: BaseMessage[] };

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
     * Middleware helper: applies inline attachment size filtering before invoking a model.
     *
     * In "inline" attachment mode, all attachment data is base64-encoded directly in
     * message content. Long reply chains can accumulate large amounts of inline data,
     * exceeding context limits. This method trims oldest attachment blocks from the
     * ephemeral message copy until the total inline data is within the configured limit.
     *
     * The original messages array (graph state) is never mutated — filtering operates
     * on a copy. This is the extension point for future per-invocation middleware.
     *
     * @param model - Any model with an `invoke(messages, options?)` method
     * @param messages - The full message array to pass to the model
     * @param options - Optional model invocation options
     */
    private async invokeWithFilter<T extends BaseMessage>(
        model: {
            invoke(messages: BaseMessage[], options?: unknown): Promise<T>;
        },
        messages: BaseMessage[],
        options?: unknown,
    ): Promise<T> {
        const filtered =
            this.attachmentMode === "inline"
                ? filterHistoryForInlineSize(messages, this.maxInlineBytes)
                : messages;
        return model.invoke(filtered, options);
    }

    /**
     * Compiles the LangGraph StateGraph. Called once in the constructor.
     *
     * The triage node uses Command.goto for dynamic routing without conditional edges.
     * Routing sentinel calls (route_to_search / route_to_general) are consumed here
     * without being added to graph state — they are invisible in persisted history.
     */
    private buildGraph() {
        return new StateGraph(MessagesAnnotation, OrchestratorContextSchema)
            .addNode("triage", this.triageNode.bind(this), {
                ends: ["executeTool", "general", "search"],
            })
            .addNode("executeTool", this.executeToolNode.bind(this))
            .addNode("general", this.generalNode.bind(this))
            .addNode("search", this.searchNode.bind(this))
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
    private async triageNode(
        state: GraphState,
        config: NodeConfig,
    ): Promise<Command> {
        config.context?.onStatusUpdate?.({ type: AgentStatusType.TRIAGE });
        const messages: BaseMessage[] = [
            new SystemMessage(TRIAGE_SYSTEM_PROMPT),
            ...state.messages,
        ];

        const triageResponse = await this.invokeWithFilter(
            this.triageModel,
            messages,
        );

        // TODO: we should check if there are more than 1 tool calls and add a log warning
        const toolCall = triageResponse.tool_calls?.[0];

        if (!toolCall) {
            this.logger.info(
                "Triage made no tool call, routing to general agent",
            );
            return new Command({ goto: "general" });
        }

        this.logger.info({ toolName: toolCall.name }, "Triage selected route");

        switch (toolCall.name) {
            case "get_website":
            case "get_video_transcription": {
                // Real tool call: add triage AIMessage to state so the ToolMessage
                // created in executeToolNode has a valid tool_call_id in history.
                //
                // Workaround for a bug in @langchain/google's legacy message converter:
                // convertLegacyContentMessageToGeminiContent looks up the AIMessage by
                // tool_call_id, then reads aiMessage.name (not the individual tool_call.name)
                // when building functionResponse.name — so it always produces "unknown".
                // Setting name on the AIMessage here makes the lookup return the correct name.
                triageResponse.name = toolCall.name;
                return new Command({
                    goto: "executeTool",
                    update: { messages: [triageResponse] },
                });
            }

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
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[] }> {
        config.context?.onStatusUpdate?.({
            type: AgentStatusType.FETCHING_CONTENT,
        });
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
        // TYPE COERCION: LangChain tool_calls args are typed as Record<string, unknown>;
        // the Zod schema on each tool guarantees the urls: string[] shape at parse time.
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
            name: toolCall.name,
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
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[] }> {
        config.context?.onStatusUpdate?.({ type: AgentStatusType.GENERATING });
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

        const response = await this.invokeWithFilter(
            this.generalModel,
            invokeMessages,
        );
        return { messages: [response] };
    }

    /**
     * Search agent node: generates an answer using the Google-Search-grounded model.
     */
    private async searchNode(
        state: GraphState,
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[] }> {
        config.context?.onStatusUpdate?.({ type: AgentStatusType.SEARCHING });
        const response = await this.invokeWithFilter(this.searchModel, [
            new SystemMessage(SEARCH_SYSTEM_PROMPT),
            ...state.messages,
        ]);
        return { messages: [response] };
    }
}
