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
import {
    Command,
    END,
    MessagesAnnotation,
    START,
    StateGraph,
} from "@langchain/langgraph";
import * as Sentry from "@sentry/bun";
import { z } from "zod/v4";
import type { GeminiFileRefreshService } from "../../../application/GeminiFileRefreshService.ts";
import type { IAgentOrchestrator } from "../../../application/ports/IAgentOrchestrator.ts";
import type { IDiscordAttachmentRefetcher } from "../../../application/ports/IDiscordAttachmentRefetcher.ts";
import type { IFreeKeyProvider } from "../../../application/ports/IFreeKeyProvider.ts";
import type { IModelProvider } from "../../../application/ports/IModelProvider.ts";
import type { OnStatusUpdate } from "../../../application/types/AgentStatus.ts";
import { AgentStatusType } from "../../../application/types/AgentStatus.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import {
    AllFreeKeysExhaustedError,
    AppError,
} from "../../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../../domain/message/GeminiApiKey.ts";
import type { DiscordMessage } from "../../../domain/message/Message.ts";
import type { AppConfig } from "../../config/config.ts";
import { filterHistoryForInlineSize } from "../inlineAttachmentFilter.ts";
import { is429Error } from "../is429Error.ts";
import {
    GENERAL_SYSTEM_PROMPT,
    type GeneralModel,
} from "../models/generalModel.ts";
import {
    SEARCH_SYSTEM_PROMPT,
    type SearchModel,
} from "../models/searchModel.ts";
import type { TriageModel } from "../models/triageModel.ts";
import { TRIAGE_SYSTEM_PROMPT } from "../models/triageModel.ts";
import type { GetVideoTranscriptionTool } from "../tools/getVideoTranscriptionTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";

/**
 * Zod schema for the LangGraph runtime context passed to each node.
 * Lives in context (not state) so it is never serialized by a checkpointer.
 */
const OrchestratorContextSchema = z.object({
    onStatusUpdate: z.custom<OnStatusUpdate>().optional(),
    attachmentRefetcher: z.custom<IDiscordAttachmentRefetcher>().optional(),
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
 *
 * Free-key rotation: triage and general nodes iterate over free API keys on HTTP 429,
 * refreshing Gemini file upload state per key before each model invocation. The search
 * node always uses the paid key with no rotation.
 */
export class AgentOrchestrator implements IAgentOrchestrator {
    // Type inferred from buildGraph() return — avoids complex LangGraph generic annotation
    // biome-ignore lint/suspicious/noExplicitAny: LangGraph compiled graph generic is impractical to annotate
    private readonly graph: ReturnType<() => any>;
    /** Pre-computed byte limit for inline attachment filtering (0 = no filtering). */
    private readonly maxInlineBytes: number;
    private readonly attachmentMode: AppConfig["attachmentMode"];

    constructor(
        private readonly triageProvider: IModelProvider<TriageModel>,
        private readonly generalProvider: IModelProvider<GeneralModel>,
        private readonly searchProvider: IModelProvider<SearchModel>,
        private readonly freeKeyProvider: IFreeKeyProvider,
        private readonly paidApiKey: GeminiApiKey,
        private readonly getWebsiteTool: GetWebsiteTool,
        private readonly getVideoTranscriptionTool: GetVideoTranscriptionTool,
        private readonly logger: Logger,
        config: Pick<AppConfig, "attachmentMode" | "maxInlineAttachmentSizeMb">,
        private readonly geminiFileRefreshService?: GeminiFileRefreshService,
    ) {
        // Upload mode uses the Gemini Files API, which is only supported by Gemini models.
        // Guard here using modelName to catch wiring mistakes early.
        if (config.attachmentMode === "upload") {
            for (const [name, modelName] of [
                ["triageProvider", triageProvider.modelName],
                ["generalProvider", generalProvider.modelName],
                ["searchProvider", searchProvider.modelName],
            ] as const) {
                if (!modelName.startsWith("gemini")) {
                    throw new Error(
                        `Orchestrator: upload attachment mode requires Gemini models, but "${name}" uses model: ${modelName}`,
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
     * @param attachmentRefetcher - Optional Discord attachment fetcher for refreshing Gemini file uploads
     */
    async process(
        history: BaseMessage[],
        userMessage: HumanMessage,
        onStatusUpdate?: OnStatusUpdate,
        attachmentRefetcher?: IDiscordAttachmentRefetcher,
    ): Promise<{ content: string; newMessages: BaseMessage[] }> {
        const initialMessages = [...history, userMessage];
        // Always pass context so nodes receive a non-optional config
        // TYPE COERCION: LangGraph's compiled graph is typed as any (see field declaration);
        // annotate the known output shape — MessagesAnnotation always produces { messages: BaseMessage[] }.
        const result = (await this.graph.invoke(
            { messages: initialMessages },
            { context: { onStatusUpdate, attachmentRefetcher } },
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
     * Invokes a model with free-key rotation on HTTP 429 (RESOURCE_EXHAUSTED).
     *
     * Iterates over free keys via {@link IFreeKeyProvider}:
     * - Attempt 0 uses the current key (shared cursor, no mutation).
     * - Attempt 1+ calls nextKey(), advancing the shared cursor (state is shared across
     *   concurrent requests — intentional for approximate load distribution).
     *
     * Before each attempt, Gemini file uploads in `messages` are refreshed for the
     * current key via {@link GeminiFileRefreshService}. This ensures that files
     * uploaded with key A are re-uploaded for key B when rotating on 429.
     *
     * Inline attachment size filtering is applied after the refresh, on the refreshed copy.
     *
     * @throws {@link AllFreeKeysExhaustedError} if all keys return 429
     * @throws The original error immediately for non-429 failures
     */
    private async invokeWithFreeKeyRotation<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => {
            invoke(messages: BaseMessage[], options?: unknown): Promise<T>;
        },
        messages: BaseMessage[],
        refetcher: IDiscordAttachmentRefetcher | undefined,
    ): Promise<T> {
        let lastErr: unknown;

        for (
            let attempt = 0;
            attempt < this.freeKeyProvider.keyCount;
            attempt++
        ) {
            // Capture the current key before invoking. Because multiple requests
            // can run concurrently, the cursor may have already been advanced by
            // another request between when we threw and when we check. Reading
            // currentKey here ensures each attempt starts with the live cursor.
            const key = this.freeKeyProvider.currentKey;

            try {
                // Refresh Gemini file uploads for this specific API key before invoking
                const refreshed =
                    this.geminiFileRefreshService && refetcher
                        ? await this.geminiFileRefreshService.refreshHistory(
                              messages,
                              refetcher,
                              key.id,
                          )
                        : messages;

                const filtered =
                    this.attachmentMode === "inline"
                        ? filterHistoryForInlineSize(
                              refreshed,
                              this.maxInlineBytes,
                          )
                        : refreshed;

                return await getModel(key).invoke(filtered);
            } catch (err) {
                if (is429Error(err)) {
                    this.logger.warn(
                        { attempt, apiKeyId: key.id },
                        "Free API key rate-limited (429); trying next key",
                    );
                    lastErr = err;
                    // Only advance the cursor if no concurrent request has already
                    // done so. If currentKey has changed since we captured it, a
                    // parallel invocation already rotated to the next key — we must
                    // not skip it by calling nextKey() again.
                    if (this.freeKeyProvider.currentKey.id === key.id) {
                        this.freeKeyProvider.nextKey();
                    }
                    continue;
                }
                // Non-429 error: propagate immediately without trying other keys
                throw err;
            }
        }

        throw new AllFreeKeysExhaustedError(lastErr);
    }

    /**
     * Invokes the paid search model with pre-invocation Gemini file refresh.
     *
     * Unlike the free-key variant, the search model uses a single paid key with no
     * rotation. Inline attachment filtering is applied after the refresh.
     */
    private async invokePaidModelWithMiddleware<T extends BaseMessage>(
        model: {
            invoke(messages: BaseMessage[], options?: unknown): Promise<T>;
        },
        messages: BaseMessage[],
        refetcher: IDiscordAttachmentRefetcher | undefined,
    ): Promise<T> {
        const refreshed =
            this.geminiFileRefreshService && refetcher
                ? await this.geminiFileRefreshService.refreshHistory(
                      messages,
                      refetcher,
                      this.paidApiKey.id,
                  )
                : messages;

        const filtered =
            this.attachmentMode === "inline"
                ? filterHistoryForInlineSize(refreshed, this.maxInlineBytes)
                : refreshed;

        return model.invoke(filtered);
    }

    /**
     * Compiles the LangGraph StateGraph. Called once in the constructor.
     *
     * The triage node uses Command.goto for dynamic routing without conditional edges.
     * Routing sentinel calls (route_to_search / route_to_general) are consumed here
     * without being added to graph state — they are invisible in persisted history.
     */
    private buildGraph() {
        let graph = new StateGraph(
            MessagesAnnotation,
            OrchestratorContextSchema,
        )
            .addNode("triage", this.triageNode.bind(this), {
                ends: ["executeTool", "general", "search"],
            })
            .addNode("executeTool", this.executeToolNode.bind(this))
            .addNode("general", this.generalNode.bind(this))
            .addNode("search", this.searchNode.bind(this))
            .addEdge(START, "triage")
            .addEdge("executeTool", "general")
            .addEdge("general", END)
            .addEdge("search", END);

        // automatic Sentry instrumentation doesn't work in Bun
        if (process.versions.bun && process.env.SENTRY_INITIALIZED) {
            graph = Sentry.instrumentLangGraph(graph);
        }

        return graph.compile();
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

        const triageResponse = await this.invokeWithFreeKeyRotation(
            this.triageProvider.get.bind(this.triageProvider),
            messages,
            config.context?.attachmentRefetcher,
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

        const response = await this.invokeWithFreeKeyRotation(
            this.generalProvider.get.bind(this.generalProvider),
            invokeMessages,
            config.context?.attachmentRefetcher,
        );
        return { messages: [response] };
    }

    /**
     * Search agent node: generates an answer using the Google-Search-grounded model.
     * Always uses the paid API key — Google Search grounding is a paid-only feature.
     */
    private async searchNode(
        state: GraphState,
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[] }> {
        config.context?.onStatusUpdate?.({ type: AgentStatusType.SEARCHING });
        const messages: BaseMessage[] = [
            new SystemMessage(SEARCH_SYSTEM_PROMPT),
            ...state.messages,
        ];
        const response = await this.invokePaidModelWithMiddleware(
            this.searchProvider.get(this.paidApiKey),
            messages,
            config.context?.attachmentRefetcher,
        );
        return { messages: [response] };
    }
}
