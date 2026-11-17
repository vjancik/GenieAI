import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { Command, END, MessagesValue, ReducedValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { type ApiKeyType, type AppConfig, SearchMode } from "../../../application/config/AppConfig.ts";
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
import { CONTENT_TOOLS, ToolName } from "../../../application/types/ToolName.ts";
import type { PersistedChatMessage } from "../../../domain/entities/Message.ts";
import { AppError, LlmError } from "../../../domain/errors/AppError.ts";
import { type FinishReason, isDegradedFinishReason } from "../../../domain/value-objects/FinishReason.ts";
import { MessageIntent } from "../../../domain/value-objects/MessageIntent.ts";
import { buildComputationSystemPrompt } from "../models/computationModel.ts";
import { buildGeneralSystemPrompt } from "../models/generalModel.ts";
import { buildSearchSystemPrompt } from "../models/searchModel.ts";
import { buildTriageSystemPrompt } from "../models/triageModel.ts";
import {
    dedupeGroundingChunks,
    safeParseTavilyResponse,
    tavilyResultsToGroundingChunks,
} from "../tools/tavilySearchTool.ts";
import { flattenToolExchanges } from "./flattenToolExchanges.ts";
import { pruneToolCalls } from "./pruneToolCalls.ts";

/**
 * Runs one `web_search` tool call and pairs its result with a ToolMessage answering that call.
 *
 * @param tavilyTool - The configured Tavily tool
 * @param toolCall - The triage `web_search` call to run
 * @param logger - Used to report responses that don't match the expected schema
 * @returns The ToolMessage, and the result's grounding chunks, or null if the response didn't
 *   match the expected schema
 */
async function runWebSearch(tavilyTool: IModelTool<{ query: string }>, toolCall: ToolCall, logger: Logger) {
    // TYPE COERCION: tool_call args typed as Record<string, unknown>; schema guarantees query: string
    const searchQuery = (toolCall.args as { query: string }).query;

    logger.debug({ searchQuery }, "Tavily search node invoking tool");

    const rawResult = await tavilyTool.invoke({ query: searchQuery });
    const { objResponse, parsed } = safeParseTavilyResponse(rawResult);

    if (!parsed.success) {
        logger.warn(
            { error: parsed.error.message },
            "Tavily response did not match expected schema — grounding sources will be omitted",
        );
    }

    return {
        toolMessage: new ToolMessage({
            content: JSON.stringify(objResponse.results),
            name: ToolName.WEB_SEARCH,
            tool_call_id: toolCall.id ?? "",
        }),
        // Results whose URL is not an absolute http(s) URL are dropped by the mapper
        groundingChunks: parsed.success ? tavilyResultsToGroundingChunks(parsed.data.results, logger) : null,
    };
}

/**
 * Scans the message history for ToolMessages from content-fetching tools and
 * collects all URLs that were successfully fetched (i.e. the result entry has
 * no `error` field).
 *
 * Returns a Set of keys in the format `"tool_name:url"` so that a new triage
 * tool call can be checked against already-fetched content, preventing the LLM
 * from re-fetching URLs whose results are already in context.
 */
function collectFetchedUrls(messages: BaseMessage[]): Set<string> {
    const fetched = new Set<string>();

    for (const msg of messages) {
        if (!(msg instanceof ToolMessage) || !msg.name || !CONTENT_TOOLS.has(msg.name)) continue;

        let entries: unknown;
        try {
            entries = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        } catch {
            continue;
        }

        if (!Array.isArray(entries)) {
            throw new AppError(
                "ORCHESTRATOR_INVALID_TOOL_MESSAGE",
                `ToolMessage content for ${msg.name} is not an array`,
            );
        }

        for (const entry of entries) {
            // Only collect successful results — entries with an `error` field are failures
            if (entry !== null && typeof entry === "object" && "url" in entry && !("error" in entry)) {
                fetched.add(`${msg.name}:${(entry as { url: string }).url}`);
            }
        }
    }

    return fetched;
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

/**
 * Graph state schema: extends the prebuilt messages reducer with an `intent` field.
 * Intent is seeded once at invocation and never mutated by nodes — the plain Zod
 * schema produces a LastValue channel (replace semantics).
 *
 * Storing intent in state (rather than context) makes it available to the
 * conditional edge function and any node without threading it through context.
 */
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

const OrchestratorStateSchema = new StateSchema({
    messages: MessagesValue,
    intent: z.custom<MessageIntent>(),
    /**
     * Set to true by an answering node (general, computation, search) when the response is
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
     * Set to true by generalNode, searchNode, or computationNode when the model stream
     * terminated without a finishReason, indicating a premature upstream termination.
     * The response content may be incomplete. Implies isRetryable.
     */
    wasInterrupted: new ReducedValue(z.boolean().default(false), booleanOrReducer),
    /**
     * Set by generalNode, searchNode, or computationNode when the model reported a finish
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

/** State update returned by the user-facing agent nodes (general, computation, search). */
type NodeResult = {
    messages: BaseMessage[];
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

/**
 * Maps each LangGraph node to its string identifier.
 * Centralizes node names to prevent typos across addNode, addEdge, Command.goto, and return types.
 */
export const OrchestratorNode = {
    TRIAGE: "triage",
    FETCH_CONTENT: "fetchContent",
    GENERAL: "general",
    COMPUTATION: "computation",
    SEARCH: "search",
} as const;

export type OrchestratorNode = (typeof OrchestratorNode)[keyof typeof OrchestratorNode];

/** Per-node model settings as parsed from the config file. */
type NodeConfigs = AppConfig["file"]["agent"]["nodes"];

/**
 * Names of the nodes that invoke a model. Derived from the config schema, so the per-node
 * settings below must cover exactly the configured nodes (no fetchContent, which has no model).
 */
type NodeName = keyof NodeConfigs;

/** Per-node maximum ms to wait for a model response before aborting. */
interface ModelTimeouts extends Record<NodeName, number> {}

/**
 * Per-node ms the main model is given to finish after the fallback model answered, in parallel
 * fallback mode. Treated as 0 when not configured (validation requires it where it matters).
 */
interface ModelGracePeriods extends Record<NodeName, number> {}

/** Per-node API key type configuration. */
interface NodeApiKeyTypes extends Record<NodeName, ApiKeyType> {}

/**
 * Per-node policy for whether a fallback model response is retryable.
 * Keyed by the nodes whose config defines `isFallbackRetryable`, i.e. the answering nodes —
 * triage routing is never surfaced as retryable.
 */
type NodeFallbackRetryable = {
    [K in NodeName as NodeConfigs[K] extends { isFallbackRetryable: boolean } ? K : never]: boolean;
};

/**
 * Orchestrates the multi-agent triage routing pipeline as a LangGraph StateGraph.
 *
 * Graph topology:
 *   START → triage → fetchContent → general → END
 *                  ↘ general      → END
 *                  ↘ computation  → END
 *                  ↘ search       → END
 *
 * Routing decisions are made in the triage node via Command.goto.
 * Routing-only tool calls (route_to_search, route_to_general) are NOT added
 * to the messages state, preventing context bloat in subsequent turns.
 * Real tool calls (get_website, get_video_captions) DO add their triage
 * AIMessage to state because it is required for the ToolMessage to be valid context.
 * If all tool calls fail, fetchContent short-circuits to END with a programmatic
 * error AIMessage, bypassing the general node to prevent hallucination.
 *
 * Key rotation: each node iterates over the keys of its configured pool (free or paid) when
 * a key is rejected (HTTP 401, 402, 403) or rate-limited (HTTP 429), refreshing Gemini file
 * upload state per key before each model invocation.
 */
export class AgentOrchestrator implements IAgentOrchestrator {
    private readonly graph: ReturnType<AgentOrchestrator["buildGraph"]>;
    private readonly nodeTimeoutsMs: ModelTimeouts;
    private readonly nodeGracePeriodsMs: ModelGracePeriods;
    private readonly nodeApiKeyTypes: NodeApiKeyTypes;
    private readonly nodeFallbackRetryable: NodeFallbackRetryable;
    private readonly searchMode: SearchMode;
    private readonly basePrompt: string;

    constructor(
        private readonly triageProvider: IModelProvider,
        private readonly generalProvider: IModelProvider,
        private readonly computationProvider: IModelProvider,
        private readonly searchProvider: IModelProvider,
        private readonly invoker: IResilientModelInvoker,
        private readonly getWebsiteTool: IModelTool<{ urls: string[] }>,
        private readonly getVideoCaptionsTool: IModelTool<{ urls: string[] }>,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
        private readonly tavilyTool?: IModelTool<{ query: string }>,
        /** Used in Tavily mode when intent is SEARCH — skips content tools and routing sentinels. */
        private readonly tavilyOnlyTriageProvider?: IModelProvider,
    ) {
        this.searchMode = config.file.agent.nodes.search.mode;
        this.basePrompt = config.file.prompts.basePrompt;
        this.nodeTimeoutsMs = {
            triage: config.file.agent.nodes.triage.timeoutMs,
            general: config.file.agent.nodes.general.timeoutMs,
            computation: config.file.agent.nodes.computation.timeoutMs,
            search: config.file.agent.nodes.search.timeoutMs,
        };
        this.nodeGracePeriodsMs = {
            triage: config.file.agent.nodes.triage.mainGracePeriodMs ?? 0,
            general: config.file.agent.nodes.general.mainGracePeriodMs ?? 0,
            computation: config.file.agent.nodes.computation.mainGracePeriodMs ?? 0,
            search: config.file.agent.nodes.search.mainGracePeriodMs ?? 0,
        };
        this.nodeApiKeyTypes = {
            triage: config.file.agent.nodes.triage.apiKeyType,
            general: config.file.agent.nodes.general.apiKeyType,
            computation: config.file.agent.nodes.computation.apiKeyType,
            search: config.file.agent.nodes.search.apiKeyType,
        };
        this.nodeFallbackRetryable = {
            general: config.file.agent.nodes.general.isFallbackRetryable,
            computation: config.file.agent.nodes.computation.isFallbackRetryable,
            search: config.file.agent.nodes.search.isFallbackRetryable,
        };
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
     * @param history - Prior messages in the reply chain, chronologically ordered
     * @param userMessage - The current user's HumanMessage (may contain multimodal content blocks)
     * @param onStatusUpdate - Optional callback invoked as the agent transitions between processing phases
     * @param attachmentFetcher - Optional Discord attachment fetcher for refreshing Gemini file uploads
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
     * Routes from START based on the declared {@link MessageIntent} in context.
     *
     * - GENERAL → general node directly (skip triage)
     * - SEARCH  → search node directly (skip triage)
     * - SUMMARY / UNKNOWN → triage (let the model decide)
     *
     * This is called as a conditional edge function; LangGraph passes the state and
     * config so the intent can be read from context without being stored in state.
     */
    private routeFromIntent(state: GraphState, _config: NodeConfig): OrchestratorNode {
        switch (state.intent) {
            case MessageIntent.GENERAL:
                return OrchestratorNode.GENERAL;
            case MessageIntent.SEARCH:
                // In Tavily mode the search node expects a triage AIMessage with a web_search
                // tool call already in state — triage must run first to produce it.
                // In Google mode there is no tool call dependency, so we can skip triage.
                return this.searchMode === SearchMode.tavily ? OrchestratorNode.TRIAGE : OrchestratorNode.SEARCH;
            default:
                return OrchestratorNode.TRIAGE;
        }
    }

    /**
     * Compiles the LangGraph StateGraph. Called once in the constructor.
     *
     * START routes via a conditional edge based on the declared intent:
     * - GENERAL → general node directly
     * - SEARCH  → search node directly
     * - SUMMARY / UNKNOWN → triage (model decides)
     *
     * The triage node uses Command.goto for dynamic routing without conditional edges.
     * Routing sentinel calls (route_to_search / route_to_general) are consumed here
     * without being added to graph state — they are invisible in persisted history.
     */
    private buildGraph() {
        let graph = new StateGraph(OrchestratorStateSchema, OrchestratorContextSchema)
            .addNode(OrchestratorNode.TRIAGE, this.triageNode.bind(this), {
                ends: [
                    OrchestratorNode.FETCH_CONTENT,
                    OrchestratorNode.GENERAL,
                    OrchestratorNode.COMPUTATION,
                    OrchestratorNode.SEARCH,
                ],
            })
            .addNode(OrchestratorNode.FETCH_CONTENT, this.fetchContentNode.bind(this), {
                ends: [OrchestratorNode.GENERAL, END],
            })
            .addNode(OrchestratorNode.GENERAL, this.generalNode.bind(this))
            .addNode(OrchestratorNode.COMPUTATION, this.computationNode.bind(this))
            .addNode(OrchestratorNode.SEARCH, this.searchNode.bind(this))
            .addConditionalEdges(START, this.routeFromIntent.bind(this), [
                OrchestratorNode.TRIAGE,
                OrchestratorNode.GENERAL,
                OrchestratorNode.SEARCH,
            ])
            .addEdge(OrchestratorNode.GENERAL, END)
            .addEdge(OrchestratorNode.COMPUTATION, END)
            .addEdge(OrchestratorNode.SEARCH, END);

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
    private async triageNode(state: GraphState, config: NodeConfig): Promise<Command> {
        return Sentry.startSpan({ name: "Triage node", op: "agent.node.triage" }, async (span) => {
            // Triage only needs the last full turn to classify, not the full history.
            // "Last full turn" = the HumanMessage immediately before the last AIMessage, through
            // to the end of state (i.e. the prior exchange + all new human messages since).
            // Walking newest→oldest: find the last AIMessage, then find the last HumanMessage
            // before it — that is the turn boundary.
            // Falls back to full history when there is no prior AIMessage in state.
            const lastAiIdx = state.messages.reduceRight(
                (found, msg, i) => (found === -1 && msg instanceof AIMessage ? i : found),
                -1,
            );
            // Last HumanMessage strictly before the last AIMessage — the start of the prior turn.
            const turnStartIdx =
                lastAiIdx === -1
                    ? -1
                    : state.messages.reduceRight(
                          (found, msg, i) => (found === -1 && i < lastAiIdx && msg instanceof HumanMessage ? i : found),
                          -1,
                      );
            const triageWindow = turnStartIdx === -1 ? state.messages : state.messages.slice(turnStartIdx);
            const messages: BaseMessage[] = [
                new SystemMessage(buildTriageSystemPrompt(this.searchMode)),
                ...triageWindow,
            ];

            // In Tavily mode with a known SEARCH intent, use the Tavily-only triage provider
            // which only has web_search + route_to_general bound — content tools are irrelevant.
            const activeTriageProvider =
                this.searchMode === SearchMode.tavily &&
                state.intent === MessageIntent.SEARCH &&
                this.tavilyOnlyTriageProvider
                    ? this.tavilyOnlyTriageProvider
                    : this.triageProvider;

            const { result: triageResponse } = await this.invoker.invoke(
                this.nodeApiKeyTypes.triage,
                activeTriageProvider.get.bind(activeTriageProvider),
                activeTriageProvider.getFallback.bind(activeTriageProvider),
                messages,
                {
                    timeoutMs: this.nodeTimeoutsMs.triage,
                    mainGracePeriodMs: this.nodeGracePeriodsMs.triage,
                    onStatusUpdate: config.context?.onStatusUpdate,
                    beforeInvokeStatus: AgentStatusType.TRIAGE,
                },
            );

            const toolCalls = triageResponse.tool_calls ?? [];

            if (toolCalls.length === 0) {
                this.logger.warn("Triage made no tool call, routing to general agent");
                span.setAttribute("agent.triage_route", "general");
                return new Command({ goto: OrchestratorNode.GENERAL });
            }

            // Partition tool calls into content fetchers and routing sentinels.
            // A single triage response may request multiple content tools (e.g. two URLs
            // of different types), all of which must be executed before the general node runs.
            // TODO: populate dynamically instead of hard coding
            const contentCalls = toolCalls.filter((tc) => CONTENT_TOOLS.has(tc.name));
            const routingCalls = toolCalls.filter((tc) => !CONTENT_TOOLS.has(tc.name));

            this.logger.info(
                { contentTools: contentCalls.map((tc) => tc.name), routingTools: routingCalls.map((tc) => tc.name) },
                "Triage tool calls",
            );
            span.setAttribute("agent.triage_route", toolCalls.map((tc) => tc.name).join(","));

            // web_search only runs when it decides the route: content tools take precedence over
            // all routing calls, and otherwise the first routing call wins.
            const isSearchRouted = contentCalls.length === 0 && routingCalls[0]?.name === ToolName.WEB_SEARCH;
            const droppedSearchCalls = isSearchRouted
                ? []
                : routingCalls.filter((tc) => tc.name === ToolName.WEB_SEARCH);
            if (droppedSearchCalls.length > 0) {
                this.logger.warn(
                    {
                        toolNames: toolCalls.map((tc) => tc.name),
                        droppedSearches: droppedSearchCalls.map((tc) => tc.args),
                    },
                    "Triage web_search calls dropped in favor of other tool calls",
                );
            }

            if (contentCalls.length > 0) {
                // Filter out URLs already fetched in this history chain to avoid
                // re-fetching content whose results are already in context.
                const alreadyFetched = collectFetchedUrls(state.messages);
                // Filter each call's URLs in-place, then drop calls with no remaining URLs.
                // TYPE COERCION: tool_call args typed as Record<string, unknown>; Zod schema guarantees urls: string[]
                const deduplicatedCalls = contentCalls.filter((tc) => {
                    const args = tc.args as { urls: string[] };
                    args.urls = args.urls.filter((url) => !alreadyFetched.has(`${tc.name}:${url}`));
                    return args.urls.length > 0;
                });

                if (deduplicatedCalls.length === 0) {
                    // All requested URLs are already in history — skip fetch, go straight to general
                    this.logger.info(
                        { skipped: contentCalls.map((tc) => tc.name) },
                        "All content tool URLs already in history, routing directly to general",
                    );
                    return new Command({ goto: OrchestratorNode.GENERAL });
                }

                // Rebuild the triage AIMessage with the pruned tool calls so that
                // fetchContentNode and the persisted history reflect only the new URLs.
                // Routing sentinels and web_search calls that accompanied them are dropped too.
                const prunedTriageResponse = pruneToolCalls(triageResponse, deduplicatedCalls);

                // Real tool calls: add triage AIMessage to state so each ToolMessage
                // created in fetchContentNode has a valid tool_call_id in history.
                return new Command({
                    goto: OrchestratorNode.FETCH_CONTENT,
                    update: { messages: [prunedTriageResponse] },
                });
            }

            // Only routing sentinels — inspect the first one (mixed routing is undefined behavior)
            const routingCall = routingCalls[0];
            if (!routingCall) {
                this.logger.warn(
                    { toolNames: toolCalls.map((tc) => tc.name) },
                    "Triage emitted only unknown tools, falling back to general",
                );
                return new Command({ goto: OrchestratorNode.GENERAL });
            }
            switch (routingCall.name) {
                case "route_to_search":
                    // Routing sentinel (Google mode): do NOT add triage message to state.
                    return new Command({ goto: OrchestratorNode.SEARCH });

                case ToolName.WEB_SEARCH:
                    // Real Tavily tool call (Tavily mode): add triage AIMessage to state so each
                    // ToolMessage created in searchNode has a valid tool_call_id in history.
                    // Only web_search calls are kept, as an accompanying routing sentinel
                    // would never receive the response the tool call pairing requires.
                    return new Command({
                        goto: OrchestratorNode.SEARCH,
                        update: {
                            messages: [
                                pruneToolCalls(
                                    triageResponse,
                                    routingCalls.filter((tc) => tc.name === ToolName.WEB_SEARCH),
                                ),
                            ],
                        },
                    });

                case "route_to_python":
                    // Routing sentinel: do NOT add triage message to state
                    return new Command({ goto: OrchestratorNode.COMPUTATION });

                case "route_to_general":
                    // Routing sentinel: do NOT add triage message to state
                    return new Command({ goto: OrchestratorNode.GENERAL });

                default:
                    this.logger.warn({ toolName: routingCall.name }, "Unknown triage tool, falling back to general");
                    return new Command({ goto: OrchestratorNode.GENERAL });
            }
        });
    }

    /**
     * Execute tool node: runs all content tool calls placed in state by triageNode.
     *
     * Reads the last message (the triage AIMessage with tool_calls) and invokes each
     * content tool in parallel, producing one ToolMessage per call.
     *
     * If every result entry across all tool calls is an error, the node short-circuits
     * to END by appending both the ToolMessages (required to satisfy LangChain's
     * tool_call_id pairing invariant) and a programmatic AIMessage so the general
     * node is never invoked with content-less context, preventing hallucination.
     * Otherwise routes to the general node.
     */
    private async fetchContentNode(state: GraphState, config: NodeConfig): Promise<Command> {
        return Sentry.startSpan({ name: "Fetch content node", op: "agent.node.fetch_content" }, async (span) => {
            config.context?.onStatusUpdate?.({
                type: AgentStatusType.FETCHING_CONTENT,
            });
            const lastMsg = state.messages.at(-1);
            const toolCalls = lastMsg instanceof AIMessage ? (lastMsg.tool_calls ?? []) : [];

            if (toolCalls.length === 0) {
                throw new AppError(
                    "ORCHESTRATOR_MISSING_TOOL_CALL",
                    "fetchContentNode reached without a tool call in state",
                );
            }

            span.setAttribute("agent.tool_names", toolCalls.map((tc) => tc.name).join(","));

            // TYPE COERCION: LangChain tool_calls args are typed as Record<string, unknown>;
            // the Zod schema on each tool guarantees the urls: string[] shape at parse time.
            const toolResults = await Promise.all(
                toolCalls.map(async (toolCall) => {
                    const result =
                        toolCall.name === ToolName.GET_WEBSITE
                            ? await this.getWebsiteTool.invoke(toolCall.args as { urls: string[] })
                            : await this.getVideoCaptionsTool.invoke(toolCall.args as { urls: string[] });
                    return { toolCall, result };
                }),
            );

            const toolMessages = toolResults.map(
                ({ toolCall, result }) =>
                    new ToolMessage({
                        // TYPE COERCION: ToolMessage.content types don't include object arrays,
                        // but LangChain and Gemini both accept structured JSON arrays at runtime.
                        content: JSON.stringify(result),
                        name: toolCall.name,
                        tool_call_id: toolCall.id ?? "",
                    }),
            );

            // Check if every entry across all tool calls is an error — if so, respond
            // programmatically rather than forwarding empty context to the general node.
            // TYPE COERCION: result union (WebsiteResultEntry[] | VideoCaptionsResultEntry[]) causes
            // TS to resolve the wrong every() overload; casting to a shared structural type is safe here.
            // const allFailed = toolResults
            //     .flatMap(({ result }) => result as { error?: string }[])
            //     .every((entry) => "error" in entry);

            // if (allFailed) {
            //     const calledTools = new Set(toolResults.map(({ toolCall }) => toolCall.name));
            //     const hasWebsite = calledTools.has("get_website");
            //     const hasVideo = calledTools.has("get_video_captions");

            //     // TYPE COERCION: tool_calls args typed as Record<string, unknown>; Zod schema guarantees urls: string[]
            //     const urlCount = (toolName: string) =>
            //         toolResults
            //             .filter(({ toolCall }) => toolCall.name === toolName)
            //             .reduce((n, { toolCall }) => n + (toolCall.args as { urls: string[] }).urls.length, 0);

            //     const videoCount = hasVideo ? urlCount("get_video_captions") : 0;
            //     const websiteCount = hasWebsite ? urlCount("get_website") : 0;
            //     const videoWord = videoCount > 1 ? "videos" : "video";
            //     const websiteWord = websiteCount > 1 ? "websites" : "website";

            //     let errorContent: string;
            //     if (hasWebsite && hasVideo) {
            //         errorContent = `I am sorry, I failed to retrieve both the captions for the ${videoWord} and the contents of the ${websiteWord} from the links you provided.`;
            //     } else if (hasVideo) {
            //         errorContent = `I am sorry, I failed to retrieve video captions for the ${videoWord} you linked.`;
            //     } else {
            //         errorContent = `I am sorry, I failed to retrieve the contents of the ${websiteWord} you linked.`;
            //     }

            //     span.setAttribute("agent.fetch_content.all_failed", true);
            //     this.logger.warn({ calledTools: [...calledTools] }, "All tool calls failed, short-circuiting to END");

            //     return new Command({
            //         goto: END,
            //         update: { messages: [...toolMessages, new AIMessage(errorContent)], isRetryable: true },
            //     });
            // }

            return new Command({
                goto: OrchestratorNode.GENERAL,
                update: { messages: toolMessages },
            });
        });
    }

    /**
     * General agent node: generates the final answer using the general-purpose model.
     *
     * When the last state message is a ToolMessage (content tool path), the system prompt
     * gains instructions for handling the retrieved content. Tool exchanges are flattened
     * into plain HumanMessages for the model call only (see {@link flattenToolExchanges});
     * state keeps the original messages.
     */
    private async generalNode(state: GraphState, config: NodeConfig): Promise<NodeResult> {
        return Sentry.startSpan({ name: "General agent node", op: "agent.node.general" }, async (span) => {
            // Derived from the raw state: flattening below removes the ToolMessages these inspect
            const lastMsg = state.messages.at(-1);
            const hasToolResult = lastMsg instanceof ToolMessage;
            const hasVideoCaptions = state.messages.some(
                (msg) => msg instanceof ToolMessage && msg.name === ToolName.GET_VIDEO_CAPTIONS,
            );
            const history = flattenToolExchanges(state.messages, this.logger);

            span.setAttributes({
                "agent.has_tool_result": hasToolResult,
                "agent.general_node.has_video_captions": hasVideoCaptions,
                "agent.flattened_tool_exchanges": history.exchangeCount,
            });

            this.logger.debug(
                { hasVideoCaptions, hasToolResult, flattenedToolExchanges: history.exchangeCount },
                "General node prompt parameters",
            );

            const invokeMessages: BaseMessage[] = [
                new SystemMessage(buildGeneralSystemPrompt(this.basePrompt, hasVideoCaptions, hasToolResult)),
                ...history.messages,
            ];

            const invocation = await this.invoker.invoke(
                this.nodeApiKeyTypes.general,
                this.generalProvider.get.bind(this.generalProvider),
                this.generalProvider.getFallback.bind(this.generalProvider),
                invokeMessages,
                {
                    timeoutMs: this.nodeTimeoutsMs.general,
                    mainGracePeriodMs: this.nodeGracePeriodsMs.general,
                    onStatusUpdate: config.context?.onStatusUpdate,
                    beforeInvokeStatus: AgentStatusType.GENERATING,
                },
            );
            const response = invocation.result;

            if (response.tool_calls && response.tool_calls.length > 0) {
                this.logger.error(
                    { toolCalls: response.tool_calls.map((tc) => tc.name) },
                    "General node: user-facing model produced illegal tool calls",
                );
                throw new LlmError("User-facing general model produced an illegal tool call");
            }

            return {
                messages: [response],
                ...degradationUpdate(invocation, this.nodeFallbackRetryable.general),
            };
        });
    }

    /**
     * Computation node: generates an answer using the code-execution-capable model.
     *
     * A simplified single-pass node — no tool pre-fetching or video caption hints.
     * The model has the native `codeExecution` tool bound, allowing it to run Python
     * to produce accurate numerical or data-processing results.
     */
    private async computationNode(state: GraphState, config: NodeConfig): Promise<NodeResult> {
        return Sentry.startSpan({ name: "Computation agent node", op: "agent.node.computation" }, async () => {
            const invokeMessages: BaseMessage[] = [
                new SystemMessage(buildComputationSystemPrompt(this.basePrompt)),
                ...state.messages,
            ];

            const invocation = await this.invoker.invoke(
                this.nodeApiKeyTypes.computation,
                this.computationProvider.get.bind(this.computationProvider),
                this.computationProvider.getFallback.bind(this.computationProvider),
                invokeMessages,
                {
                    timeoutMs: this.nodeTimeoutsMs.computation,
                    mainGracePeriodMs: this.nodeGracePeriodsMs.computation,
                    onStatusUpdate: config.context?.onStatusUpdate,
                    beforeInvokeStatus: AgentStatusType.COMPUTING,
                },
            );

            return {
                messages: [invocation.result],
                ...degradationUpdate(invocation, this.nodeFallbackRetryable.computation),
            };
        });
    }

    /**
     * Search agent node: generates an answer using a search-backed model.
     *
     * In Google mode: passes the system prompt and state to the Gemini model with
     * native Google Search grounding bound. Always uses the paid API key.
     *
     * In Tavily mode: reads the `web_search` tool calls from the triage AIMessage already in
     * state, invokes the Tavily tool once per call in parallel, then appends one ToolMessage per
     * call to the history before invoking the LLM. The ToolMessages and the final AIMessage are
     * included in the state update so they are persisted for future turns.
     *
     * In both modes, tool exchanges are flattened into plain HumanMessages for the model call
     * only (see {@link flattenToolExchanges}); state keeps the original messages.
     */
    private async searchNode(state: GraphState, config: NodeConfig): Promise<NodeResult> {
        return Sentry.startSpan({ name: "Search agent node", op: "agent.node.search" }, async (span) => {
            if (this.searchMode === SearchMode.tavily) {
                if (!this.tavilyTool) {
                    throw new AppError(
                        "ORCHESTRATOR_MISSING_TAVILY_TOOL",
                        "Search mode is tavily but no tavilyTool was provided to the orchestrator",
                    );
                }

                // The triage AIMessage (with its web_search tool calls) was added to state by
                // triageNode. It may hold several: despite the single-query tool schema, the model
                // occasionally splits a search, and every call needs its own ToolMessage.
                const triageMessage = state.messages.at(-1);
                const webSearchCalls =
                    triageMessage instanceof AIMessage
                        ? (triageMessage.tool_calls ?? []).filter((tc) => tc.name === ToolName.WEB_SEARCH)
                        : [];
                if (webSearchCalls.length === 0) {
                    throw new AppError(
                        "ORCHESTRATOR_MISSING_SEARCH_QUERY",
                        "Tavily search mode: expected last state message to carry a web_search tool call",
                    );
                }

                const tavilyTool = this.tavilyTool;
                const searches = await Promise.all(
                    webSearchCalls.map((toolCall) => runWebSearch(tavilyTool, toolCall, this.logger)),
                );
                const tavilyResultMessages = searches.map(({ toolMessage }) => toolMessage);
                span.setAttribute("agent.web_search_count", searches.length);

                // Grounding chunks in the Google Search shape, to be merged onto the final AIMessage
                // so resolveGroundingSources can extract Tavily sources transparently.
                // Only populated from successful schema parses; searches can overlap, so a source
                // found by more than one of them is listed once.
                const parsedGroundingChunks = searches.flatMap(({ groundingChunks }) =>
                    groundingChunks === null ? [] : [groundingChunks],
                );
                const tavilyGroundingKwargs =
                    parsedGroundingChunks.length > 0
                        ? {
                              groundingMetadata: {
                                  groundingChunks: dedupeGroundingChunks(parsedGroundingChunks.flat()),
                              },
                          }
                        : {};

                // The current turn's results must be flattened along with their triage tool calls,
                // which are already on the last state message.
                const history = flattenToolExchanges([...state.messages, ...tavilyResultMessages], this.logger);
                span.setAttribute("agent.flattened_tool_exchanges", history.exchangeCount);

                const invokeMessages: BaseMessage[] = [
                    new SystemMessage(buildSearchSystemPrompt(this.basePrompt, this.searchMode)),
                    ...history.messages,
                ];

                const invocation = await this.invoker.invoke(
                    this.nodeApiKeyTypes.search,
                    this.searchProvider.get.bind(this.searchProvider),
                    this.searchProvider.getFallback.bind(this.searchProvider),
                    invokeMessages,
                    {
                        timeoutMs: this.nodeTimeoutsMs.search,
                        mainGracePeriodMs: this.nodeGracePeriodsMs.search,
                        onStatusUpdate: config.context?.onStatusUpdate,
                        beforeInvokeStatus: AgentStatusType.SEARCHING,
                    },
                );
                const result = invocation.result;

                Object.assign(result.additional_kwargs, tavilyGroundingKwargs);

                if (result.tool_calls && result.tool_calls.length > 0) {
                    this.logger.error(
                        { toolCalls: result.tool_calls.map((tc) => tc.name) },
                        "Search node (Tavily mode): user-facing model produced illegal tool calls",
                    );
                    throw new LlmError("User-facing search model produced an illegal tool call");
                }

                return {
                    messages: [...tavilyResultMessages, result],
                    ...degradationUpdate(invocation, this.nodeFallbackRetryable.search),
                };
            }

            const history = flattenToolExchanges(state.messages, this.logger);
            span.setAttribute("agent.flattened_tool_exchanges", history.exchangeCount);

            const messages: BaseMessage[] = [
                new SystemMessage(buildSearchSystemPrompt(this.basePrompt, this.searchMode)),
                ...history.messages,
            ];
            const invocation = await this.invoker.invoke(
                this.nodeApiKeyTypes.search,
                this.searchProvider.get.bind(this.searchProvider),
                this.searchProvider.getFallback.bind(this.searchProvider),
                messages,
                {
                    timeoutMs: this.nodeTimeoutsMs.search,
                    mainGracePeriodMs: this.nodeGracePeriodsMs.search,
                    onStatusUpdate: config.context?.onStatusUpdate,
                    beforeInvokeStatus: AgentStatusType.SEARCHING,
                },
            );
            const response = invocation.result;

            if (response.tool_calls && response.tool_calls.length > 0) {
                this.logger.error(
                    { toolCalls: response.tool_calls.map((tc) => tc.name) },
                    "Search node (Google mode): user-facing model produced illegal tool calls",
                );
                throw new LlmError("User-facing search model produced an illegal tool call");
            }

            return {
                messages: [response],
                ...degradationUpdate(invocation, this.nodeFallbackRetryable.search),
            };
        });
    }
}
