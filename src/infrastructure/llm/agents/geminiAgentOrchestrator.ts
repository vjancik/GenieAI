import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Command, END, MessagesValue, ReducedValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import type { TavilySearch } from "@langchain/tavily";
import * as Sentry from "@sentry/bun";
import { z } from "zod/v4";
import { type AppConfig, AttachmentMode, SearchMode } from "../../../application/config/AppConfig.ts";
import type { IAgentOrchestrator } from "../../../application/ports/IAgentOrchestrator.ts";
import type { IModelProvider } from "../../../application/ports/IModelProvider.ts";
import type { IRoundRobinKeyProvider } from "../../../application/ports/IRoundRobinKeyProvider.ts";
import type { GeminiFileRefreshService } from "../../../application/services/GeminiFileRefreshService.ts";
import type { OnStatusUpdate } from "../../../application/types/AgentStatus.ts";
import { AgentStatusType } from "../../../application/types/AgentStatus.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { AllFreeKeysExhaustedError, AppError, PaidKeyExhaustedError } from "../../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../../domain/message/GeminiApiKey.ts";
import type { DiscordMessage } from "../../../domain/message/Message.ts";
import { MessageIntent } from "../../../domain/message/MessageIntent.ts";
import { is429Error } from "../errors/is429Error.ts";
import { isModelFallbackError } from "../errors/isModelFallbackError.ts";
import { buildGeneralSystemPrompt, type GeneralModel } from "../models/generalModel.ts";
import { buildSearchSystemPrompt, type SearchModel } from "../models/searchModel.ts";
import type { TriageModel } from "../models/triageModel.ts";
import { TRIAGE_SYSTEM_PROMPT } from "../models/triageModel.ts";
import type { GetVideoCaptionsTool } from "../tools/getVideoCaptionsTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";
import { safeParseTavilyResponse } from "../tools/tavilySearchTool.ts";
import { filterHistoryForInlineSize } from "../utils/inlineAttachmentFilter.ts";
import { dbMessagesToLangchain, extractContent } from "../utils/messageTransformers.ts";

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

const OrchestratorStateSchema = new StateSchema({
    messages: MessagesValue,
    intent: z.custom<MessageIntent>(),
    /** Query string emitted by the triage model when routing to Tavily search. */
    searchQuery: z.string().optional(),
    /**
     * Set to true by generalNode or searchNode when the fallback model was used.
     * Signals to the caller that the response quality may be degraded and a retry is worthwhile.
     * Defaults to false; never set to true by triageNode (routing quality is unaffected).
     *
     * Uses a boolean OR reducer so that once any node sets this to true it is never
     * overwritten back to false by a subsequent node's replace-semantics update.
     */
    isRetryable: new ReducedValue(z.boolean().default(false), booleanOrReducer),
    /**
     * Set to true by generalNode or searchNode when a fallback model was used to generate
     * the response. Distinct from isRetryable: isRetryable covers all degraded-response cases
     * (e.g. all tools failed), while usedFallback specifically means the primary model was
     * unavailable and a lower-quality fallback was substituted.
     *
     * Used to display an informational footer on the bot reply so the user understands
     * why response quality may be degraded, independent of retry eligibility.
     */
    usedFallback: new ReducedValue(z.boolean().default(false), booleanOrReducer),
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
    SEARCH: "search",
} as const;

export type OrchestratorNode = (typeof OrchestratorNode)[keyof typeof OrchestratorNode];

/**
 * Per-model timeout and fallback provider configuration.
 * Each model type has an independent timeout and can surface a fallback model
 * via its provider's getFallback() method.
 */
export interface ModelTimeouts {
    /** Maximum ms to wait for a triage model response before aborting. */
    triage: number;
    /** Maximum ms to wait for a general model response before aborting. */
    general: number;
    /** Maximum ms to wait for a search model response before aborting. */
    search: number;
}

/** Minimal invokable model interface used by the rotation and fallback helpers. */
type InvokableModel<T extends BaseMessage> = {
    invoke(messages: BaseMessage[], options?: unknown): Promise<T>;
};

/**
 * Orchestrates the multi-agent triage routing pipeline as a LangGraph StateGraph.
 *
 * Graph topology:
 *   START → triage → fetchContent → general → END
 *                  ↘            ↘ END (all tools failed)
 *                  ↘ general → END
 *                  ↘ search  → END
 *
 * Routing decisions are made in the triage node via Command.goto.
 * Routing-only tool calls (route_to_search, route_to_general) are NOT added
 * to the messages state, preventing context bloat in subsequent turns.
 * Real tool calls (get_website, get_video_captions) DO add their triage
 * AIMessage to state because it is required for the ToolMessage to be valid context.
 * If all tool calls fail, fetchContent short-circuits to END with a programmatic
 * error AIMessage, bypassing the general node to prevent hallucination.
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
    private readonly attachmentMode: AttachmentMode;
    private readonly nodeTimeoutsMs: ModelTimeouts;
    private readonly globalModelTimeoutMs: number;
    private readonly searchMode: SearchMode;

    constructor(
        private readonly triageProvider: IModelProvider<TriageModel>,
        private readonly generalProvider: IModelProvider<GeneralModel>,
        private readonly searchProvider: IModelProvider<SearchModel>,
        private readonly freeKeyProvider: IRoundRobinKeyProvider,
        private readonly paidKeyProvider: IRoundRobinKeyProvider,
        private readonly getWebsiteTool: GetWebsiteTool,
        private readonly getVideoCaptionsTool: GetVideoCaptionsTool,
        private readonly logger: Logger,
        config: Pick<AppConfig, "file">,
        private readonly geminiFileRefreshService?: GeminiFileRefreshService,
        private readonly tavilyTool?: TavilySearch,
    ) {
        const searchMode = config.file.agent.nodes.search.mode;
        this.searchMode = searchMode;
        // Upload mode uses the Gemini Files API, which is only supported by Gemini models.
        // Guard here using modelName to catch wiring mistakes early.
        if (config.file.agent.uploadAttachmentMode === AttachmentMode.upload) {
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

        this.attachmentMode = config.file.agent.uploadAttachmentMode;
        this.maxInlineBytes = config.file.agent.maxInlineAttachmentSizeMB * 1024 * 1024;
        this.globalModelTimeoutMs = config.file.globalModelTimeoutMs;
        this.nodeTimeoutsMs = {
            triage: config.file.agent.nodes.triage.timeoutMs,
            general: config.file.agent.nodes.general.timeoutMs,
            search: config.file.agent.nodes.search.timeoutMs,
        };
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
     * @param attachmentFetcher - Optional Discord attachment fetcher for refreshing Gemini file uploads
     */
    async process(
        messages: BaseMessage[],
        intent: MessageIntent,
        onStatusUpdate?: OnStatusUpdate,
    ): Promise<{ content: string; newMessages: BaseMessage[]; isRetryable: boolean; usedFallback: boolean }> {
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
                    { messages, intent },
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
                    content: extractContent(lastMessage),
                    newMessages,
                    isRetryable: result.isRetryable,
                    usedFallback: result.usedFallback,
                };
            },
        );
    }

    /**
     * Shared invocation core: runs the model against `keyProvider` with file refresh,
     * inline filtering, 503/timeout fallback, and 429 rotation.
     *
     * - Attempt 0 uses the current key (shared cursor, no mutation).
     * - Attempt 1+ calls nextKey(), advancing the shared cursor.
     *
     * @throws {@link AllFreeKeysExhaustedError} if `isPaid` is false and all keys return 429
     * @throws {@link PaidKeyExhaustedError} if `isPaid` is true and the key returns 429
     * @throws The original error immediately for non-429 / non-fallback failures
     */
    private async invokeWithKeyRotation<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => InvokableModel<T>,
        getFallbackModel: ((key: GeminiApiKey) => InvokableModel<T> | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs: number | undefined,
        keyProvider: IRoundRobinKeyProvider,
        isPaid: boolean,
    ): Promise<{ result: T; usedFallback: boolean }> {
        return Sentry.startSpan(
            {
                name: "Invoke model with key rotation",
                op: "llm.invoke",
            },
            async (span) => {
                let lastErr: unknown;

                for (let attempt = 0; attempt < keyProvider.keyCount; attempt++) {
                    // Capture the current key before invoking. Because multiple requests
                    // can run concurrently, the cursor may have already been advanced by
                    // another request between when we threw and when we check. Reading
                    // currentKey here ensures each attempt starts with the live cursor.
                    const key = keyProvider.currentKey;

                    let filtered: BaseMessage[] = [];
                    try {
                        // Refresh Gemini file uploads for this specific API key before invoking
                        // TODO: make a mandatory dependency until there's a way to make this work in inline mode
                        // with pre-existing gemini file URLs in history
                        const refreshed = this.geminiFileRefreshService
                            ? await this.geminiFileRefreshService.refreshHistory(messages, key.id)
                            : messages;

                        filtered =
                            this.attachmentMode === AttachmentMode.inline
                                ? filterHistoryForInlineSize(refreshed, this.maxInlineBytes)
                                : refreshed;

                        const result = await getModel(key).invoke(filtered, {
                            timeout: timeoutMs ?? this.globalModelTimeoutMs,
                        });
                        span.setAttributes({
                            "llm.attempt_count": attempt + 1,
                            "llm.api_key_id": key.id,
                        });
                        return { result, usedFallback: false };
                    } catch (err) {
                        if (is429Error(err)) {
                            this.logger.warn(
                                { attempt, apiKeyId: key.id },
                                isPaid
                                    ? "Paid API key rate-limited (429)"
                                    : "Free API key rate-limited (429); trying next key",
                            );
                            lastErr = err;
                            // Only advance the cursor if no concurrent request has already
                            // done so. If currentKey has changed since we captured it, a
                            // parallel invocation already rotated to the next key — we must
                            // not skip it by calling nextKey() again.
                            if (keyProvider.currentKey.id === key.id) {
                                keyProvider.nextKey();
                            }
                            continue;
                        }

                        // On 503 or timeout: try the fallback model with the same key and timeout.
                        // If no fallback is configured, or the fallback also fails, propagate.
                        if (isModelFallbackError(err) && getFallbackModel) {
                            const fallbackModel = getFallbackModel(key);
                            if (!fallbackModel) throw err;
                            this.logger.warn(
                                { attempt, apiKeyId: key.id, errName: (err as Error).name },
                                "Primary model failed with 503/timeout; trying fallback model",
                            );
                            // Reuse filtered — same key, same messages, no re-refresh needed
                            const fallbackResult = await fallbackModel.invoke(filtered, {
                                timeout: timeoutMs ?? this.globalModelTimeoutMs,
                            });
                            span.setAttributes({
                                "llm.attempt_count": attempt + 1,
                                "llm.api_key_id": key.id,
                                "llm.used_fallback": true,
                            });
                            return { result: fallbackResult, usedFallback: true };
                        }

                        // Non-429, non-fallback error: propagate immediately without trying other keys
                        throw err;
                    }
                }

                throw isPaid ? new PaidKeyExhaustedError(lastErr) : new AllFreeKeysExhaustedError(lastErr);
            },
        );
    }

    /**
     * Invokes a model using the shared free-key pool with round-robin 429 rotation.
     *
     * @throws {@link AllFreeKeysExhaustedError} if all free keys are rate-limited
     */
    private invokeWithFreeKeyRotation<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => InvokableModel<T>,
        getFallbackModel: ((key: GeminiApiKey) => InvokableModel<T> | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
    ): Promise<{ result: T; usedFallback: boolean }> {
        return this.invokeWithKeyRotation(getModel, getFallbackModel, messages, timeoutMs, this.freeKeyProvider, false);
    }

    /**
     * Invokes a model using the single paid API key.
     *
     * To switch a node to this path, replace its {@link invokeWithFreeKeyRotation} call
     * with this method and pass the relevant provider's `get` / `getFallback` bindings.
     *
     * @throws {@link PaidKeyExhaustedError} if the paid key is rate-limited
     */
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: temporarily unused
    private _invokeWithPaidKey<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => InvokableModel<T>,
        getFallbackModel: ((key: GeminiApiKey) => InvokableModel<T> | undefined) | undefined,
        messages: BaseMessage[],
        timeoutMs?: number,
    ): Promise<{ result: T; usedFallback: boolean }> {
        return this.invokeWithKeyRotation(getModel, getFallbackModel, messages, timeoutMs, this.paidKeyProvider, true);
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
                return OrchestratorNode.SEARCH;
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
                ends: [OrchestratorNode.FETCH_CONTENT, OrchestratorNode.GENERAL, OrchestratorNode.SEARCH],
            })
            .addNode(OrchestratorNode.FETCH_CONTENT, this.fetchContentNode.bind(this), {
                ends: [OrchestratorNode.GENERAL, END],
            })
            .addNode(OrchestratorNode.GENERAL, this.generalNode.bind(this))
            .addNode(OrchestratorNode.SEARCH, this.searchNode.bind(this))
            .addConditionalEdges(START, this.routeFromIntent.bind(this), [
                OrchestratorNode.TRIAGE,
                OrchestratorNode.GENERAL,
                OrchestratorNode.SEARCH,
            ])
            .addEdge(OrchestratorNode.GENERAL, END)
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
            config.context?.onStatusUpdate?.({
                type: AgentStatusType.TRIAGE,
            });
            // Triage only needs the current turn to classify — pass just the messages
            // starting from the second-to-last HumanMessage (i.e. the prior user turn
            // plus: last AI response, any tool messages, and the new user message).
            // Slicing from that index (inclusive) ensures the window always starts with
            // a HumanMessage, satisfying Gemini's turn-ordering requirement.
            // Falls back to full history if there is no prior HumanMessage.
            const secondToLastHumanIdx = state.messages.reduceRight(
                (found, msg, i) =>
                    found === -1 && i < state.messages.length - 1 && msg instanceof HumanMessage ? i : found,
                -1,
            );
            const triageWindow =
                secondToLastHumanIdx === -1 ? state.messages : state.messages.slice(secondToLastHumanIdx);
            const messages: BaseMessage[] = [new SystemMessage(TRIAGE_SYSTEM_PROMPT), ...triageWindow];

            const { result: triageResponse } = await this.invokeWithFreeKeyRotation(
                this.triageProvider.get.bind(this.triageProvider),
                this.triageProvider.getFallback.bind(this.triageProvider),
                messages,
                this.nodeTimeoutsMs?.triage,
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
            const CONTENT_TOOLS = new Set(["get_website", "get_video_captions"]);
            const contentCalls = toolCalls.filter((tc) => CONTENT_TOOLS.has(tc.name));
            const routingCalls = toolCalls.filter((tc) => !CONTENT_TOOLS.has(tc.name));

            this.logger.info(
                { contentTools: contentCalls.map((tc) => tc.name), routingTools: routingCalls.map((tc) => tc.name) },
                "Triage tool calls",
            );
            span.setAttribute("agent.triage_route", toolCalls.map((tc) => tc.name).join(","));

            if (contentCalls.length > 0) {
                // Real tool calls: add triage AIMessage to state so each ToolMessage
                // created in fetchContentNode has a valid tool_call_id in history.
                return new Command({
                    goto: OrchestratorNode.FETCH_CONTENT,
                    update: { messages: [triageResponse] },
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
                case "route_to_search": {
                    // Routing sentinel: do NOT add triage message to state.
                    // Capture the query arg if the triage model provided one (Tavily mode).
                    const searchQuery = (routingCall.args as { query?: string }).query;
                    return new Command({ goto: OrchestratorNode.SEARCH, update: { searchQuery } });
                }

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
                        toolCall.name === "get_website"
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
     * When the last state message is a ToolMessage (content tool path), appends an
     * instruction prompt to focus the model on the retrieved content. This extra
     * HumanMessage is passed transiently to the model and is NOT stored in state.
     */
    private async generalNode(
        state: GraphState,
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[]; isRetryable: boolean; usedFallback: boolean }> {
        return Sentry.startSpan({ name: "General agent node", op: "agent.node.general" }, async (span) => {
            config.context?.onStatusUpdate?.({
                type: AgentStatusType.GENERATING,
            });
            const lastMsg = state.messages.at(-1);
            const hasToolResult = lastMsg instanceof ToolMessage;
            const hasVideoCaptions = state.messages.some(
                (msg) => msg instanceof ToolMessage && msg.name === "get_video_captions",
            );

            const dateStr = new Date().toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
            });

            span.setAttributes({
                "agent.has_tool_result": hasToolResult,
                "agent.general_node.date_str": dateStr,
                "agent.general_node.has_video_captions": hasVideoCaptions,
            });

            this.logger.debug({ dateStr, hasVideoCaptions, hasToolResult }, "General node prompt parameters");

            const invokeMessages: BaseMessage[] = [
                new SystemMessage(buildGeneralSystemPrompt(dateStr, hasVideoCaptions, hasToolResult)),
                ...state.messages,
            ];

            const { result: response, usedFallback } = await this.invokeWithFreeKeyRotation(
                this.generalProvider.get.bind(this.generalProvider),
                this.generalProvider.getFallback.bind(this.generalProvider),
                invokeMessages,
                this.nodeTimeoutsMs?.general,
            );
            return { messages: [response], isRetryable: usedFallback, usedFallback };
        });
    }

    /**
     * Search agent node: generates an answer using a search-backed model.
     *
     * In Google mode: passes the system prompt and state to the Gemini model with
     * native Google Search grounding bound. Always uses the paid API key.
     *
     * In Tavily mode: calls the Tavily tool directly with the query captured by triage,
     * then injects two "fake" messages into history before invoking the LLM so the model
     * sees the search results as prior context without a live tool-call round-trip:
     *   1. An AIMessage with a `tavily_search` tool_call (mirrors what the model would emit)
     *   2. A ToolMessage carrying the raw Tavily result entries
     * Both messages are included in the state update so they are persisted for future turns.
     */
    private async searchNode(
        state: GraphState,
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[]; isRetryable: boolean; usedFallback: boolean }> {
        return Sentry.startSpan({ name: "Search agent node", op: "agent.node.search" }, async () => {
            config.context?.onStatusUpdate?.({
                type: AgentStatusType.SEARCHING,
            });

            const dateStr = new Date().toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
            });

            if (this.searchMode === SearchMode.tavily) {
                const { searchQuery } = state;

                if (!searchQuery) {
                    // Should not happen in Tavily mode — triage tool always supplies a query.
                    throw new AppError(
                        "ORCHESTRATOR_MISSING_SEARCH_QUERY",
                        "Tavily search mode requires a query from triage, but none was found in state",
                    );
                }

                if (!this.tavilyTool) {
                    throw new AppError(
                        "ORCHESTRATOR_MISSING_TAVILY_TOOL",
                        "Search mode is tavily but no tavilyTool was provided to the orchestrator",
                    );
                }

                this.logger.debug({ searchQuery }, "Tavily search node invoking tool");

                const toolCallId = Math.random().toString(36).slice(2);
                const rawResult = await this.tavilyTool.invoke({ query: searchQuery });
                const { objResponse, parsed } = safeParseTavilyResponse(rawResult);

                if (!parsed.success) {
                    this.logger.warn(
                        { error: parsed.error.message },
                        "Tavily response did not match expected schema — grounding sources will be omitted",
                    );
                }

                // Synthetic AIMessage representing what the model would have emitted to call Tavily.
                const tavilyCallMessage = new AIMessage({
                    tool_calls: [{ name: "tavily_search", args: { query: searchQuery }, id: toolCallId }],
                });

                // ToolMessage carrying the raw result object — passed through regardless of schema
                // validation so the LLM always receives the search content.
                const tavilyResultMessage = new ToolMessage({
                    content: JSON.stringify(objResponse.results),
                    name: "tavily_search",
                    tool_call_id: toolCallId,
                });

                // Grounding chunks in the Google Search shape, to be merged onto the final AIMessage
                // so resolveGroundingSources can extract Tavily sources transparently.
                // Only populated on successful schema parse; title is the hostname of the result URL.
                const tavilyGroundingKwargs = parsed.success
                    ? {
                          groundingMetadata: {
                              groundingChunks: parsed.data.results.map((r) => ({
                                  web: { uri: r.url, title: new URL(r.url).hostname.replace(/^www\./, "") },
                              })),
                          },
                      }
                    : {};

                const invokeMessages: BaseMessage[] = [
                    new SystemMessage(buildSearchSystemPrompt(dateStr, this.searchMode)),
                    ...state.messages,
                    tavilyCallMessage,
                    tavilyResultMessage,
                ];

                const { result, usedFallback } = await this.invokeWithFreeKeyRotation(
                    this.searchProvider.get.bind(this.searchProvider),
                    this.searchProvider.getFallback.bind(this.searchProvider),
                    invokeMessages,
                    this.nodeTimeoutsMs?.search,
                );

                result.additional_kwargs = { ...result.additional_kwargs, ...tavilyGroundingKwargs };

                return {
                    messages: [tavilyCallMessage, tavilyResultMessage, result],
                    isRetryable: usedFallback,
                    usedFallback,
                };
            }

            // Google mode: warn if triage unexpectedly produced a query (misconfiguration).
            if (state.searchQuery) {
                this.logger.warn(
                    { searchQuery: state.searchQuery },
                    "Triage generated a search query parameter in Google Search mode — query is ignored",
                );
            }

            const messages: BaseMessage[] = [
                new SystemMessage(buildSearchSystemPrompt(dateStr, this.searchMode)),
                ...state.messages,
            ];
            const { result: response, usedFallback } = await this.invokeWithFreeKeyRotation(
                this.searchProvider.get.bind(this.searchProvider),
                this.searchProvider.getFallback.bind(this.searchProvider),
                messages,
                this.nodeTimeoutsMs?.search,
            );
            return { messages: [response], isRetryable: usedFallback, usedFallback };
        });
    }
}
