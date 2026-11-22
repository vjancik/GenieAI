import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Command, END, MessagesValue, ReducedValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { type AppConfig, AttachmentMode, SearchMode } from "../../../application/config/AppConfig.ts";
import { dbMessagesToLangchain, extractContent } from "../../../application/helpers/langchainMessageTransformers.ts";
import type { IAgentOrchestrator } from "../../../application/ports/IAgentOrchestrator.ts";
import type { IModelProvider } from "../../../application/ports/IModelProvider.ts";
import type { IModelTool } from "../../../application/ports/IModelTool.ts";
import type {
    IResilientModelInvoker,
    ModelInvocationResult,
} from "../../../application/ports/IResilientModelInvoker.ts";
import type { OnStatusUpdate } from "../../../application/types/AgentStatus.ts";
import { AgentStatusType } from "../../../application/types/AgentStatus.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { CONTENT_TOOLS, RoutingSentinel, ToolName } from "../../../application/types/ToolName.ts";
import type { PersistedChatMessage } from "../../../domain/entities/Message.ts";
import { AppError, LlmError } from "../../../domain/errors/AppError.ts";
import { type FinishReason, isDegradedFinishReason } from "../../../domain/value-objects/FinishReason.ts";
import { MessageIntent } from "../../../domain/value-objects/MessageIntent.ts";
import { buildComputationSystemPrompt } from "../models/computationModel.ts";
import { buildGeneralSystemPrompt } from "../models/generalModel.ts";
import { buildGoogleSearchSystemPrompt } from "../models/googleSearchModel.ts";
import { buildTriageSystemPrompt } from "../models/triageModel.ts";
import { searchResultsToGroundingChunks } from "../tools/tavilySearchTool.ts";
import { flattenToolExchanges } from "./flattenToolExchanges.ts";
import { type AnsweringNode, OrchestratorNode } from "./orchestratorNode.ts";
import { pruneToolCalls } from "./pruneToolCalls.ts";
import { collectFetchedUrls, planTriageRoute, TriageOutcome } from "./triageRoutePlanner.ts";

/**
 * Returns the messages triage needs to classify the request: the last full turn rather than
 * the full history.
 *
 * "Last full turn" = the HumanMessage immediately before the last AIMessage, through to the
 * end of the history (i.e. the prior exchange + all new human messages since).
 * Falls back to the full history when there is no prior AIMessage.
 */
function selectTriageWindow(messages: BaseMessage[]): BaseMessage[] {
    const lastAiIdx = messages.findLastIndex((msg) => msg instanceof AIMessage);
    if (lastAiIdx === -1) return messages;

    // Last HumanMessage strictly before the last AIMessage — the start of the prior turn.
    const turnStartIdx = messages.findLastIndex((msg, i) => i < lastAiIdx && msg instanceof HumanMessage);
    return turnStartIdx === -1 ? messages : messages.slice(turnStartIdx);
}

/**
 * Returns the ToolMessages at the very end of the history: the results of the tools that ran
 * in the current turn, which no answering node has responded to yet.
 */
function trailingToolMessages(messages: BaseMessage[]): ToolMessage[] {
    const firstIdx = messages.findLastIndex((msg) => !(msg instanceof ToolMessage)) + 1;
    return messages.slice(firstIdx).filter((msg) => msg instanceof ToolMessage);
}

/** Parses a ToolMessage's JSON string content, returning null when it is not valid JSON. */
function parseToolResult(message: ToolMessage): unknown {
    if (typeof message.content !== "string") return message.content;
    try {
        return JSON.parse(message.content);
    } catch {
        return null;
    }
}

/** Returns the results of the web searches that ran in the current turn. */
function currentSearchResults(messages: BaseMessage[]): ToolMessage[] {
    return trailingToolMessages(messages).filter((msg) => msg.name === ToolName.WEB_SEARCH);
}

/**
 * Derives the prompt hints for answering a turn from the tool results in its history.
 *
 * @returns `hasVideoCaptions` when video captions were fetched at any point in the history, and
 *   `hasFetchedContent` / `hasSearchResults` when the current turn ran a content tool / web search
 */
function retrievedContextHints(messages: BaseMessage[]) {
    const turnResults = trailingToolMessages(messages);
    return {
        hasVideoCaptions: messages.some(
            (msg) => msg instanceof ToolMessage && msg.name === ToolName.GET_VIDEO_CAPTIONS,
        ),
        hasFetchedContent: turnResults.some((msg) => msg.name !== undefined && CONTENT_TOOLS.has(msg.name)),
        hasSearchResults: turnResults.some((msg) => msg.name === ToolName.WEB_SEARCH),
    };
}

// ⚠️  TEMPORARY WORKAROUND — remove once fixed upstream in @langchain/google
// BUG: AIMessage content blocks of type "executableCode" and "codeExecutionResult"
// are forwarded to the Gemini API with the LangChain `type` discriminant field
// intact (e.g. `{ type: "executableCode", executableCode: {...} }`). The Gemini
// API rejects any part that carries an unrecognised top-level field — it only
// accepts the nested payload key alone (e.g. `{ executableCode: {...} }`).
// Tracked in: tests/unit/llm/langchainGoogleBugs.test.ts
//   "AIMessage executableCode and codeExecutionResult blocks are serialized with type field present"
function stripCodeExecutionTypeFields(messages: BaseMessage[]): BaseMessage[] {
    const CODE_EXECUTION_TYPES = new Set(["executableCode", "codeExecutionResult"]);
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        const content = message.content as Record<string, unknown>[];
        for (const part of content) {
            if (CODE_EXECUTION_TYPES.has(part.type as string)) {
                delete part.type;
            }
        }
    }
    return messages;
}
// ⚠️  END TEMPORARY WORKAROUND

/** Boolean OR reducer: once true, never reverts to false across node updates. */
const booleanOrReducer = {
    inputSchema: z.boolean(),
    reducer: (current: boolean, next: boolean) => current || next,
};

/**
 * Sticky-first reducer for the finish reason: keeps the first degraded reason recorded.
 * Nodes only emit a value when generation ended abnormally, so a later successful node
 * (which emits null) can never clear an earlier failure.
 */
const firstDegradedReasonReducer = {
    inputSchema: z.custom<FinishReason | null>(),
    reducer: (current: FinishReason | null, next: FinishReason | null) => current ?? next,
};

/**
 * Graph state schema: extends the prebuilt messages reducer with an `intent` field and the
 * response-degradation flags reported back to the caller.
 * Intent is seeded once at invocation and never mutated by nodes — the plain Zod
 * schema produces a LastValue channel (replace semantics).
 *
 * Storing intent in state (rather than context) makes it available to the
 * conditional edge function and any node without threading it through context.
 */
const OrchestratorStateSchema = new StateSchema({
    messages: MessagesValue,
    intent: z.custom<MessageIntent>(),
    /**
     * The node that answers once the tools node is done. Set by triageNode whenever it routes
     * to the tools node, and only read there: routes that skip the tools node don't need it.
     *
     * Kept out of `messages` on purpose, as the routing sentinel it stems from must not reach
     * the conversation history.
     */
    answerNode: z.custom<AnsweringNode>().optional(),
    /**
     * Set to true by an answering node (general, computation, googleSearch) when the response is
     * degraded and a retry is worthwhile: the stream was interrupted, generation stopped
     * abnormally, or a fallback model answered and that node's `isFallbackRetryable` is enabled.
     * Defaults to false; never set to true by triageNode (routing quality is unaffected).
     *
     * Uses a boolean OR reducer so that once any node sets this to true it is never
     * overwritten back to false by a subsequent node's replace-semantics update.
     */
    isRetryable: new ReducedValue(z.boolean().default(false), booleanOrReducer),
    /**
     * Set to true by an answering node when a fallback model generated the response, i.e. the
     * primary model was unavailable. Always reported, independent of isRetryable: the fallback
     * may be configured as an equal alternative, in which case the response is not retryable.
     *
     * Persisted with the bot reply. The fallback footer keys off usedRetryableFallback instead.
     */
    usedFallback: new ReducedValue(z.boolean().default(false), booleanOrReducer),
    /**
     * Set to true by an answering node when a fallback model generated the response and that
     * node's `isFallbackRetryable` is enabled, i.e. the fallback itself is a reason to retry.
     * Implies usedFallback and isRetryable.
     *
     * Kept separate from isRetryable, which may also be set by an interruption or a degraded
     * finish reason, so the caller only shows the fallback footer when the fallback is the reason.
     */
    usedRetryableFallback: new ReducedValue(z.boolean().default(false), booleanOrReducer),
    /**
     * Set to true by an answering node when the model stream
     * terminated without a finishReason, indicating a premature upstream termination.
     * The response content may be incomplete. Implies isRetryable.
     */
    wasInterrupted: new ReducedValue(z.boolean().default(false), booleanOrReducer),
    /**
     * Set by an answering node when the model reported a finish
     * reason other than STOP (e.g. SAFETY), meaning generation ended abnormally and the
     * response is visibly truncated. Implies isRetryable.
     *
     * Stays null on a clean stop, so the value is only ever a degraded reason. Distinct from
     * wasInterrupted: that flag covers the absence of any reported reason, this one carries
     * the reason the model gave. The two are mutually exclusive per invocation.
     *
     * Triage deliberately does not report here: a blocked triage call still routes to a node
     * that produces a real answer, so surfacing it to the user would be a false alarm.
     */
    finishReason: new ReducedValue(z.custom<FinishReason | null>().default(null), firstDegradedReasonReducer),
});

/**
 * Zod schema for the LangGraph runtime context passed to each node.
 * Lives in context (not state) so it is never serialized by a checkpointer.
 * Intent was moved to state; only ephemeral per-invocation callbacks remain here.
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

/** State update returned by the user-facing agent nodes (general, computation, googleSearch). */
type NodeResult = {
    messages: [AIMessage];
    isRetryable: boolean;
    usedFallback: boolean;
    usedRetryableFallback: boolean;
    wasInterrupted: boolean;
    finishReason: FinishReason | null;
};

/**
 * Derives the response-degradation fields of a node's state update from an invocation result.
 *
 * Only a degraded finish reason is written to state, so a clean STOP leaves the channel null
 * and the sticky reducer never treats a success as a failure. An interruption or a degraded
 * finish reason always makes the response retryable: a fresh generation often clears a
 * transient safety block or glitch. Fallback use only does so when the node opts in, since
 * a fallback may be an equal alternative rather than a downgrade.
 *
 * @param invocation - The resilient invoker's result for the node's model call
 * @param isFallbackRetryable - The node's configured policy for responses from its fallback model
 */
function degradationUpdate(
    invocation: Pick<ModelInvocationResult, "usedFallback" | "wasInterrupted" | "finishReason">,
    isFallbackRetryable: boolean,
): Omit<NodeResult, "messages"> {
    const degradedReason = isDegradedFinishReason(invocation.finishReason) ? invocation.finishReason : null;
    const usedRetryableFallback = invocation.usedFallback && isFallbackRetryable;
    return {
        isRetryable: usedRetryableFallback || invocation.wasInterrupted || degradedReason !== null,
        usedFallback: invocation.usedFallback,
        usedRetryableFallback,
        wasInterrupted: invocation.wasInterrupted,
        finishReason: degradedReason,
    };
}

/** Graph state type — messages + intent seeded at invocation. */
type GraphState = typeof OrchestratorStateSchema.State;

/** Per-node model settings as parsed from the config file. */
type NodeSettings = AppConfig["file"]["agent"]["nodes"];

/** Names of the nodes that invoke a model (so not the tools node). */
type ModelNodeName = keyof NodeSettings;

/** What distinguishes one answering node's model call from another's. */
interface AnswerSpec {
    node: AnsweringNode;
    /** Sentry span name of the node. */
    spanName: string;
    provider: IModelProvider;
    systemPrompt: string;
    /** Status emitted right before the model call. */
    status: AgentStatusType;
    /** Node-specific facts about the prompt, recorded on the span and in the debug log. */
    attributes?: Record<string, string | number | boolean>;
}

/**
 * Orchestrates the multi-agent triage routing pipeline as a LangGraph StateGraph.
 *
 * Graph topology:
 *   START → triage → tools → general      → END
 *                          ↘ computation  → END
 *                          ↘ googleSearch → END
 *                  ↘ general              → END
 *                  ↘ computation          → END
 *                  ↘ googleSearch         → END
 *
 * Triage makes two kinds of tool calls, which can be combined:
 * - Real tool calls (get_website, get_video_captions, and web_search in Tavily mode) retrieve
 *   data and are all executed by the tools node. Their triage AIMessage IS added to state,
 *   because it is required for the resulting ToolMessages to be valid context.
 * - Routing sentinels (route_to_search, route_to_python, route_to_general) pick the node that
 *   answers, after the tools node when there are real tool calls. They are NOT added to the
 *   messages state, preventing context bloat in subsequent turns. Without one, the general node
 *   answers.
 *
 * Web search works differently per search mode. In Google mode it is an answering node of its
 * own (googleSearch), whose model searches by itself through native grounding. In Tavily mode it
 * is a tool like any other: its results are answered from by whichever node triage picked,
 * the general node by default, and the googleSearch node is never reached.
 *
 * Key rotation: each node iterates over the keys of its configured pool (free or paid) when
 * a key is rejected (HTTP 401, 402, 403) or rate-limited (HTTP 429), refreshing Gemini file
 * upload state per key before each model invocation.
 */
export class AgentOrchestrator implements IAgentOrchestrator {
    private readonly graph: ReturnType<AgentOrchestrator["buildGraph"]>;
    private readonly nodes: NodeSettings;
    private readonly searchMode: SearchMode;
    private readonly basePrompt: string;
    /** Whether files found by the website tool are embedded for the model, see {@link flattenToolExchanges}. */
    private readonly embedExternalFiles: boolean;
    /** The tools the tools node can execute, by the name triage calls them with. */
    private readonly tools: ReadonlyMap<string, IModelTool<Record<string, unknown>>>;
    private readonly toolNames: ReadonlySet<string>;
    /** The answering node of each routing sentinel triage can follow in the active search mode. */
    private readonly sentinelRoutes: ReadonlyMap<string, AnsweringNode>;

    /**
     * @param googleSearchProvider - The Google Search grounding model, only invoked in Google mode
     * @param tavilyTool - The web search tool, required when the search mode is Tavily
     * @param searchIntentTriageProvider - Used in Tavily mode when the intent is SEARCH: a triage
     *   model whose main job is to write the search query
     * @throws AppError (`ORCHESTRATOR_MISSING_TAVILY_TOOL`) when the search mode is Tavily but
     *   no Tavily tool was provided
     */
    constructor(
        private readonly triageProvider: IModelProvider,
        private readonly generalProvider: IModelProvider,
        private readonly computationProvider: IModelProvider,
        private readonly googleSearchProvider: IModelProvider,
        private readonly invoker: IResilientModelInvoker,
        getWebsiteTool: IModelTool<{ urls: string[] }>,
        getVideoCaptionsTool: IModelTool<{ urls: string[] }>,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
        tavilyTool?: IModelTool<{ query: string }>,
        private readonly searchIntentTriageProvider?: IModelProvider,
    ) {
        this.nodes = config.file.agent.nodes;
        this.searchMode = config.file.agent.searchMode;
        this.basePrompt = config.file.prompts.basePrompt;
        // Only upload mode resolves the media blocks such files are embedded as
        this.embedExternalFiles = config.file.agent.uploadAttachmentMode === AttachmentMode.upload;

        if (this.searchMode === SearchMode.tavily && !tavilyTool) {
            throw new AppError(
                "ORCHESTRATOR_MISSING_TAVILY_TOOL",
                "Search mode is tavily but no tavilyTool was provided to the orchestrator",
            );
        }

        const tools = new Map<string, IModelTool<Record<string, unknown>>>([
            [ToolName.GET_WEBSITE, getWebsiteTool],
            [ToolName.GET_VIDEO_CAPTIONS, getVideoCaptionsTool],
        ]);
        if (tavilyTool) tools.set(ToolName.WEB_SEARCH, tavilyTool);
        this.tools = tools;
        this.toolNames = new Set(tools.keys());

        const sentinelRoutes = new Map<string, AnsweringNode>([
            [RoutingSentinel.GENERAL, OrchestratorNode.GENERAL],
            [RoutingSentinel.PYTHON, OrchestratorNode.COMPUTATION],
        ]);
        // The Google Search node only exists as a destination in Google mode
        if (this.searchMode === SearchMode.google) {
            sentinelRoutes.set(RoutingSentinel.SEARCH, OrchestratorNode.GOOGLE_SEARCH);
        }
        this.sentinelRoutes = sentinelRoutes;

        this.graph = this.buildGraph();
    }

    /**
     * Deserializes persisted {@link PersistedChatMessage} records into LangChain messages.
     * Delegates to {@link dbMessagesToLangchain} — see that function for full documentation.
     *
     * Exposed here so the application layer can call it through {@link IAgentOrchestrator}
     * without importing infrastructure utilities directly.
     */
    buildHistory(records: PersistedChatMessage[]): BaseMessage[] {
        return dbMessagesToLangchain(records, this.logger);
    }

    /**
     * Process a user message with conversation history.
     *
     * Returns the display content string and all new LangChain messages generated
     * during processing (for persistence). The newMessages array includes intermediate
     * messages (triage response, tool messages) so history has no gaps.
     *
     * @param messages - The reply chain in chronological order, ending with the current user's
     *   HumanMessage (which may contain multimodal content blocks)
     * @param intent - The user's declared intent, used to bypass triage for explicit commands
     * @param onStatusUpdate - Optional callback invoked as the agent transitions between processing phases
     */
    async process(
        messages: BaseMessage[],
        intent: MessageIntent,
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<{
        content: string;
        newMessages: BaseMessage[];
        isRetryable: boolean;
        usedFallback: boolean;
        usedRetryableFallback: boolean;
        wasInterrupted: boolean;
        finishReason: FinishReason | null;
    }> {
        const lastMessage = messages.at(-1);
        if (!(lastMessage instanceof HumanMessage)) {
            throw new Error(
                `Programmatic error: last message passed to orchestrator.process must be a HumanMessage, got ${lastMessage?.constructor.name ?? "undefined"}`,
            );
        }

        return Sentry.startSpan(
            {
                name: "Orchestrate agent pipeline",
                op: "agent.process",
                attributes: { "agent.history_length": messages.length, "agent.intent": intent },
            },
            async (span) => {
                const result = await this.graph.invoke(
                    { messages: stripCodeExecutionTypeFields(messages), intent },
                    // TODO: factor out into it's own service that uses a fire-and-forget messaging pattern
                    { context: { onStatusUpdate } },
                );

                // Everything after the initial seed is "new" — generated during this turn
                const newMessages = result.messages.slice(messages.length);
                const lastMessage = result.messages.at(-1);
                if (!lastMessage) {
                    throw new AppError("ORCHESTRATOR_NO_RESPONSE", "Graph produced no messages");
                }

                span.setAttribute("agent.new_messages_count", newMessages.length);
                return {
                    content: extractContent(lastMessage.content),
                    newMessages,
                    isRetryable: result.isRetryable,
                    usedFallback: result.usedFallback,
                    usedRetryableFallback: result.usedRetryableFallback,
                    wasInterrupted: result.wasInterrupted,
                    finishReason: result.finishReason,
                };
            },
        );
    }

    /**
     * Routes from START based on the declared {@link MessageIntent} in state.
     *
     * - GENERAL → general node directly (skip triage)
     * - SEARCH  → googleSearch node directly in Google mode; triage in Tavily mode
     * - SUMMARY / UNKNOWN → triage (let the model decide)
     *
     * This is called as a conditional edge function.
     */
    private routeFromIntent(state: GraphState): OrchestratorNode {
        switch (state.intent) {
            case MessageIntent.GENERAL:
                return OrchestratorNode.GENERAL;
            case MessageIntent.SEARCH:
                // In Google mode the search model does its own searching, so triage can be
                // skipped. In Tavily mode a search is a tool call, and it takes triage to write
                // its query.
                return this.searchMode === SearchMode.google ? OrchestratorNode.GOOGLE_SEARCH : OrchestratorNode.TRIAGE;
            default:
                return OrchestratorNode.TRIAGE;
        }
    }

    /**
     * Compiles the LangGraph StateGraph. Called once in the constructor.
     *
     * START routes via a conditional edge based on the declared intent, see
     * {@link routeFromIntent}. The triage and tools nodes use Command.goto for dynamic routing
     * without conditional edges.
     */
    private buildGraph() {
        const answeringNodes = [OrchestratorNode.GENERAL, OrchestratorNode.COMPUTATION, OrchestratorNode.GOOGLE_SEARCH];

        let graph = new StateGraph(OrchestratorStateSchema, OrchestratorContextSchema)
            .addNode(OrchestratorNode.TRIAGE, this.triageNode.bind(this), {
                ends: [OrchestratorNode.TOOLS, ...answeringNodes],
            })
            .addNode(OrchestratorNode.TOOLS, this.toolsNode.bind(this), { ends: answeringNodes })
            .addNode(OrchestratorNode.GENERAL, this.generalNode.bind(this))
            .addNode(OrchestratorNode.COMPUTATION, this.computationNode.bind(this))
            .addNode(OrchestratorNode.GOOGLE_SEARCH, this.googleSearchNode.bind(this))
            .addConditionalEdges(START, this.routeFromIntent.bind(this), [
                OrchestratorNode.TRIAGE,
                OrchestratorNode.GENERAL,
                OrchestratorNode.GOOGLE_SEARCH,
            ])
            .addEdge(OrchestratorNode.GENERAL, END)
            .addEdge(OrchestratorNode.COMPUTATION, END)
            .addEdge(OrchestratorNode.GOOGLE_SEARCH, END);

        // automatic Sentry instrumentation doesn't work in Bun
        if (process.versions.bun && process.env.SENTRY_INITIALIZED) {
            graph = Sentry.instrumentStateGraph(graph);
        }

        return graph.compile();
    }

    /**
     * Invokes a node's model through the resilient invoker, with that node's configured key
     * pool, timeout and grace period.
     *
     * @param node - The node whose settings apply
     * @param provider - Supplies the node's primary and fallback models
     * @param messages - The full prompt, system message included
     * @param status - Status emitted right before the model call
     */
    private invokeModel(
        node: ModelNodeName,
        provider: IModelProvider,
        messages: BaseMessage[],
        status: AgentStatusType,
        config: NodeConfig,
    ) {
        const settings = this.nodes[node];
        return this.invoker.invoke(
            settings.apiKeyType,
            provider.get.bind(provider),
            provider.getFallback.bind(provider),
            messages,
            {
                timeoutMs: settings.timeoutMs,
                // Validation requires the grace period wherever it matters
                mainGracePeriodMs: settings.mainGracePeriodMs ?? 0,
                onStatusUpdate: config.context?.onStatusUpdate,
                beforeInvokeStatus: status,
            },
        );
    }

    /**
     * Triage node: classifies the request via a single model call and routes accordingly,
     * see {@link planTriageRoute} for the routing rules.
     *
     * Returns a Command that routes to the answering node, or first to the tools node when
     * real tool calls are to be executed. Only in the latter case is the triage AIMessage added
     * to state; routing sentinels are intentionally NOT added to prevent context bloat in
     * future turns.
     */
    private async triageNode(state: GraphState, config: NodeConfig): Promise<Command> {
        return Sentry.startSpan({ name: "Triage node", op: "agent.node.triage" }, async (span) => {
            // In Tavily mode a declared SEARCH intent gets its own triage model and prompt,
            // geared towards writing the search query
            const isSearchRequested =
                this.searchMode === SearchMode.tavily &&
                state.intent === MessageIntent.SEARCH &&
                this.searchIntentTriageProvider !== undefined;
            const provider =
                isSearchRequested && this.searchIntentTriageProvider
                    ? this.searchIntentTriageProvider
                    : this.triageProvider;

            const messages: BaseMessage[] = [
                new SystemMessage(buildTriageSystemPrompt(this.searchMode, isSearchRequested)),
                ...selectTriageWindow(state.messages),
            ];

            const { result: triageResponse } = await this.invokeModel(
                "triage",
                provider,
                messages,
                AgentStatusType.TRIAGE,
                config,
            );

            const toolCalls = triageResponse.tool_calls ?? [];
            const plan = planTriageRoute(
                toolCalls,
                this.toolNames,
                this.sentinelRoutes,
                collectFetchedUrls(state.messages),
            );

            const toolNames = toolCalls.map((tc) => tc.name);
            span.setAttributes({
                "agent.triage_route": toolNames.length > 0 ? toolNames.join(",") : plan.answerNode,
                "agent.triage_outcome": plan.outcome,
                "agent.triage_answer_node": plan.answerNode,
            });

            const decision = { toolNames, outcome: plan.outcome, answerNode: plan.answerNode };
            switch (plan.outcome) {
                case TriageOutcome.NO_TOOL_CALL:
                    this.logger.warn(decision, "Triage made no tool call, routing to general agent");
                    break;
                case TriageOutcome.UNKNOWN_TOOL:
                    this.logger.warn(decision, "Triage emitted only unknown tools, falling back to general");
                    break;
                case TriageOutcome.ALREADY_FETCHED:
                    this.logger.info(decision, "All content tool URLs already in history, skipping the fetch");
                    break;
                default:
                    this.logger.info(decision, "Triage tool calls");
            }

            if (plan.toolCalls.size === 0) return new Command({ goto: plan.answerNode });

            // Real tool calls: add the triage AIMessage to state so each ToolMessage created by
            // the tools node has a valid tool_call_id in history. It is reduced to the calls
            // that will actually run, as every call left on it needs a response.
            return new Command({
                goto: OrchestratorNode.TOOLS,
                update: {
                    messages: [pruneToolCalls(triageResponse, plan.toolCalls)],
                    answerNode: plan.answerNode,
                },
            });
        });
    }

    /**
     * Tools node: runs all tool calls placed in state by triageNode.
     *
     * Reads the last message (the triage AIMessage with tool_calls) and invokes each tool in
     * parallel, producing one ToolMessage per call. A failed fetch is not an error here: content
     * tools report failures per URL in their result, which the answering node relays.
     *
     * Routes to the answering node triage picked, the general node by default.
     *
     * @throws AppError (`ORCHESTRATOR_MISSING_TOOL_CALL`) when state holds no tool call to run
     * @throws AppError (`ORCHESTRATOR_UNKNOWN_TOOL`) when a tool call names a tool that isn't registered
     */
    private async toolsNode(state: GraphState, config: NodeConfig): Promise<Command> {
        return Sentry.startSpan({ name: "Tools node", op: "agent.node.tools" }, async (span) => {
            const lastMsg = state.messages.at(-1);
            const toolCalls = lastMsg instanceof AIMessage ? (lastMsg.tool_calls ?? []) : [];

            if (toolCalls.length === 0) {
                throw new AppError("ORCHESTRATOR_MISSING_TOOL_CALL", "toolsNode reached without a tool call in state");
            }

            const answerNode = state.answerNode ?? OrchestratorNode.GENERAL;
            span.setAttributes({
                "agent.tool_names": toolCalls.map((tc) => tc.name).join(","),
                "agent.web_search_count": toolCalls.filter((tc) => tc.name === ToolName.WEB_SEARCH).length,
                "agent.answer_node": answerNode,
            });

            // A turn that both searches and fetches content is reported as a search
            config.context?.onStatusUpdate?.({
                type: toolCalls.some((tc) => tc.name === ToolName.WEB_SEARCH)
                    ? AgentStatusType.SEARCHING
                    : AgentStatusType.FETCHING_CONTENT,
            });

            const toolMessages = await Promise.all(
                toolCalls.map(async (toolCall) => {
                    const tool = this.tools.get(toolCall.name);
                    if (!tool) {
                        throw new AppError("ORCHESTRATOR_UNKNOWN_TOOL", `No tool registered for ${toolCall.name}`);
                    }

                    this.logger.debug({ toolName: toolCall.name, args: toolCall.args }, "Tools node invoking tool");
                    const result = await tool.invoke(toolCall.args);
                    return new ToolMessage({
                        // A tool without a result still has to answer its call
                        content: JSON.stringify(result ?? null),
                        name: toolCall.name,
                        tool_call_id: toolCall.id ?? "",
                    });
                }),
            );

            return new Command({ goto: answerNode, update: { messages: toolMessages } });
        });
    }

    /**
     * Generates the user-facing answer of an answering node: the shared part of the general,
     * computation and googleSearch nodes.
     *
     * Tool exchanges are flattened into plain HumanMessages for the model call only (see
     * {@link flattenToolExchanges}); state keeps the original messages.
     *
     * When the current turn ran web searches, their sources are attached to the answer as
     * grounding chunks in the Google Search shape, so resolveGroundingSources can extract them
     * the same way as natively grounded ones.
     *
     * @throws LlmError when the model answers with a tool call. Answering models have no callable
     *   tools, and a call persisted without a response would invalidate the history.
     */
    private async answer(spec: AnswerSpec, state: GraphState, config: NodeConfig): Promise<NodeResult> {
        return Sentry.startSpan(
            { name: spec.spanName, op: `agent.node.${spec.node}`, attributes: spec.attributes },
            async (span) => {
                const history = flattenToolExchanges(state.messages, this.logger, {
                    embedExternalFiles: this.embedExternalFiles,
                });
                span.setAttribute("agent.flattened_tool_exchanges", history.exchangeCount);
                this.logger.debug(
                    { node: spec.node, ...spec.attributes, flattenedToolExchanges: history.exchangeCount },
                    "Answering node prompt parameters",
                );

                const invocation = await this.invokeModel(
                    spec.node,
                    spec.provider,
                    [new SystemMessage(spec.systemPrompt), ...history.messages],
                    spec.status,
                    config,
                );
                const response = invocation.result;

                if (response.tool_calls && response.tool_calls.length > 0) {
                    this.logger.error(
                        { node: spec.node, toolCalls: response.tool_calls.map((tc) => tc.name) },
                        "User-facing model produced illegal tool calls",
                    );
                    throw new LlmError(`User-facing ${spec.node} model produced an illegal tool call`);
                }

                const groundingChunks = searchResultsToGroundingChunks(
                    currentSearchResults(state.messages).map(parseToolResult),
                    this.logger,
                );
                if (groundingChunks !== null) {
                    response.additional_kwargs.groundingMetadata = { groundingChunks };
                }

                return {
                    messages: [response],
                    ...degradationUpdate(invocation, this.nodes[spec.node].isFallbackRetryable),
                };
            },
        );
    }

    /**
     * General agent node: generates the final answer using the general-purpose model.
     *
     * Also answers from whatever the tools node retrieved in the current turn (unless triage
     * picked another node for that): the system prompt then gains instructions for handling
     * the fetched content and web search results.
     */
    private async generalNode(state: GraphState, config: NodeConfig): Promise<NodeResult> {
        const hints = retrievedContextHints(state.messages);

        return this.answer(
            {
                node: OrchestratorNode.GENERAL,
                spanName: "General agent node",
                provider: this.generalProvider,
                systemPrompt: buildGeneralSystemPrompt(this.basePrompt, hints),
                status: AgentStatusType.GENERATING,
                attributes: {
                    "agent.has_tool_result": hints.hasFetchedContent,
                    "agent.has_search_results": hints.hasSearchResults,
                    "agent.general_node.has_video_captions": hints.hasVideoCaptions,
                },
            },
            state,
            config,
        );
    }

    /**
     * Computation node: generates an answer using the code-execution-capable model.
     *
     * The model has the native `codeExecution` tool bound, allowing it to run Python
     * to produce accurate numerical or data-processing results.
     */
    private async computationNode(state: GraphState, config: NodeConfig): Promise<NodeResult> {
        const hints = retrievedContextHints(state.messages);

        return this.answer(
            {
                node: OrchestratorNode.COMPUTATION,
                spanName: "Computation agent node",
                provider: this.computationProvider,
                systemPrompt: buildComputationSystemPrompt(this.basePrompt, hints),
                status: AgentStatusType.COMPUTING,
                attributes: {
                    "agent.has_tool_result": hints.hasFetchedContent,
                    "agent.has_search_results": hints.hasSearchResults,
                },
            },
            state,
            config,
        );
    }

    /**
     * Google Search agent node: generates an answer using the Gemini model with native Google
     * Search grounding bound, which searches on its own.
     *
     * Only reachable in Google search mode. In Tavily mode, web searches are run by the tools
     * node instead.
     */
    private async googleSearchNode(state: GraphState, config: NodeConfig): Promise<NodeResult> {
        const hints = retrievedContextHints(state.messages);

        return this.answer(
            {
                node: OrchestratorNode.GOOGLE_SEARCH,
                spanName: "Google Search agent node",
                provider: this.googleSearchProvider,
                systemPrompt: buildGoogleSearchSystemPrompt(this.basePrompt, hints),
                status: AgentStatusType.SEARCHING,
                attributes: { "agent.has_tool_result": hints.hasFetchedContent },
            },
            state,
            config,
        );
    }
}
