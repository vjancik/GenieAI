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
import { Command, END, MessagesValue, ReducedValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import * as Sentry from "@sentry/bun";
import { z } from "zod/v4";
import type { IAgentOrchestrator } from "../../../application/ports/IAgentOrchestrator.ts";
import type { IDiscordAttachmentFetcher } from "../../../application/ports/IDiscordAttachmentFetcher.ts";
import type { IFreeKeyProvider } from "../../../application/ports/IFreeKeyProvider.ts";
import type { IModelProvider } from "../../../application/ports/IModelProvider.ts";
import type { GeminiFileRefreshService } from "../../../application/services/GeminiFileRefreshService.ts";
import type { OnStatusUpdate } from "../../../application/types/AgentStatus.ts";
import { AgentStatusType } from "../../../application/types/AgentStatus.ts";
import type { Logger } from "../../../application/types/Logger.ts";
import { AllFreeKeysExhaustedError, AppError } from "../../../domain/errors/AppError.ts";
import type { GeminiApiKey } from "../../../domain/message/GeminiApiKey.ts";
import type { DiscordMessage } from "../../../domain/message/Message.ts";
import { MessageIntent } from "../../../domain/message/MessageIntent.ts";
import type { AppConfig } from "../../config/config.ts";
import { is429Error } from "../errors/is429Error.ts";
import { isModelFallbackError } from "../errors/isModelFallbackError.ts";
import { filterHistoryForInlineSize } from "../inlineAttachmentFilter.ts";
import { buildGeneralSystemPrompt, type GeneralModel } from "../models/generalModel.ts";
import { SEARCH_SYSTEM_PROMPT, type SearchModel } from "../models/searchModel.ts";
import type { TriageModel } from "../models/triageModel.ts";
import { TRIAGE_SYSTEM_PROMPT } from "../models/triageModel.ts";
import type { GetVideoCaptionsTool } from "../tools/getVideoCaptionsTool.ts";
import type { GetWebsiteTool } from "../tools/getWebsiteTool.ts";

const GLOBAL_MODEL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per invoke

/**
 * Graph state schema: extends the prebuilt messages reducer with an `intent` field.
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
     * Set to true by generalNode or searchNode when the fallback model was used.
     * Signals to the caller that the response quality may be degraded and a retry is worthwhile.
     * Defaults to false; never set to true by triageNode (routing quality is unaffected).
     *
     * Uses a boolean OR reducer so that once any node sets this to true it is never
     * overwritten back to false by a subsequent node's replace-semantics update.
     */
    isRetryable: new ReducedValue(z.boolean().default(false), {
        inputSchema: z.boolean(),
        reducer: (current, next) => current || next,
    }),
});

/**
 * Zod schema for the LangGraph runtime context passed to each node.
 * Lives in context (not state) so it is never serialized by a checkpointer.
 * Intent was moved to state; only ephemeral per-invocation callbacks remain here.

 */
const OrchestratorContextSchema = z.object({
    onStatusUpdate: z.custom<OnStatusUpdate>().optional(),
    attachmentFetcher: z.custom<IDiscordAttachmentFetcher>().optional(),
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
function stripThoughtChunks(json: Record<string, unknown>): Record<string, unknown> {
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
                (part) => !(typeof part === "object" && part !== null && part.thought === true),
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
function deserializeMessage(json: Record<string, unknown>, logger: Logger): BaseMessage {
    // TYPE COERCION: json.id is unknown; per LangChain's serialization format it is a string[]
    // representing the module path (e.g. ["langchain_core", "messages", "HumanMessage"]).
    const className = (json.id as string[]).at(-1);
    // TYPE COERCION: json.kwargs is unknown; it is always a Record of named constructor
    // arguments in LangChain's serialization format.
    const kwargs = json.kwargs as Record<string, unknown>;

    // TODO: some potentially important properties might be missing from kwargs, see if this is the right way to deserialize
    switch (className) {
        case "HumanMessage":
            return new HumanMessage(kwargs);
        case "AIMessage":
            return new AIMessage(kwargs);
        case "ToolMessage":
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ToolMessage's strict constructor union type; double cast through unknown is required.
            return new ToolMessage(kwargs as unknown as ConstructorParameters<typeof ToolMessage>[0]);
        case "ChatMessage":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ChatMessage's strict constructor union type; double cast through unknown is required.
            return new ChatMessage(kwargs as unknown as ConstructorParameters<typeof ChatMessage>[0]);
        case "FunctionMessage":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // FunctionMessage's strict constructor union type; double cast through unknown is required.
            return new FunctionMessage(kwargs as unknown as ConstructorParameters<typeof FunctionMessage>[0]);
        case "RemoveMessage":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // RemoveMessage's strict constructor union type; double cast through unknown is required.
            return new RemoveMessage(kwargs as unknown as ConstructorParameters<typeof RemoveMessage>[0]);
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
            throw new AppError("UNKNOWN_MESSAGE_TYPE", `Cannot deserialize unknown message type: ${className}`);
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
            const prepared = filterThoughtChunks ? stripThoughtChunks(json) : json;
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
    triageTimeoutMs: number;
    /** Maximum ms to wait for a general model response before aborting. */
    generalTimeoutMs: number;
    /** Maximum ms to wait for a search model response before aborting. */
    searchTimeoutMs: number;
}

/** Minimal invokable model interface used by the rotation and fallback helpers. */
type InvokableModel<T extends BaseMessage> = {
    invoke(messages: BaseMessage[], options?: unknown): Promise<T>;
};

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
 * Real tool calls (get_website, get_video_captions) DO add their triage
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
        private readonly getVideoCaptionsTool: GetVideoCaptionsTool,
        private readonly logger: Logger,
        config: Pick<AppConfig, "attachmentMode" | "maxInlineAttachmentSizeMb">,
        private readonly geminiFileRefreshService?: GeminiFileRefreshService,
        private readonly modelTimeouts?: ModelTimeouts,
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
     * @param attachmentFetcher - Optional Discord attachment fetcher for refreshing Gemini file uploads
     */
    async process(
        history: BaseMessage[],
        userMessage: HumanMessage,
        intent: MessageIntent,
        onStatusUpdate?: OnStatusUpdate,
        attachmentFetcher?: IDiscordAttachmentFetcher,
    ): Promise<{ content: string; newMessages: BaseMessage[]; isRetryable: boolean }> {
        return Sentry.startSpan(
            {
                name: "Orchestrate agent pipeline",
                op: "agent.process",
                attributes: { "agent.history_length": history.length, "agent.intent": intent },
            },
            async (span) => {
                const initialMessages = [...history, userMessage];
                const result = await this.graph.invoke(
                    { messages: initialMessages, intent },
                    { context: { onStatusUpdate, attachmentFetcher } },
                );

                // Everything after the initial seed is "new" — generated during this turn
                const newMessages = result.messages.slice(initialMessages.length);
                const lastMessage = result.messages.at(-1);
                if (!lastMessage) {
                    throw new AppError("ORCHESTRATOR_NO_RESPONSE", "Graph produced no messages");
                }

                span.setAttribute("agent.new_messages_count", newMessages.length);
                return { content: extractContent(lastMessage), newMessages, isRetryable: result.isRetryable };
            },
        );
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
     * On 503 or timeout errors, if `getFallbackModel` is provided, a single fallback attempt
     * is made with the same key and the same timeout before propagating the error. 429 errors
     * bypass the fallback and are handled exclusively by key rotation.
     *
     * @throws {@link AllFreeKeysExhaustedError} if all keys return 429
     * @throws The original error immediately for non-429 / non-fallback failures
     */
    private async invokeWithFreeKeyRotation<T extends BaseMessage>(
        getModel: (key: GeminiApiKey) => InvokableModel<T>,
        getFallbackModel: ((key: GeminiApiKey) => InvokableModel<T> | undefined) | undefined,
        messages: BaseMessage[],
        attachmentFetcher: IDiscordAttachmentFetcher | undefined,
        timeoutMs?: number,
    ): Promise<{ result: T; usedFallback: boolean }> {
        return Sentry.startSpan(
            {
                name: "Invoke model with free key rotation",
                op: "llm.invoke.free_key",
            },
            async (span) => {
                let lastErr: unknown;

                for (let attempt = 0; attempt < this.freeKeyProvider.keyCount; attempt++) {
                    // Capture the current key before invoking. Because multiple requests
                    // can run concurrently, the cursor may have already been advanced by
                    // another request between when we threw and when we check. Reading
                    // currentKey here ensures each attempt starts with the live cursor.
                    const key = this.freeKeyProvider.currentKey;

                    let filtered: BaseMessage[] = [];
                    try {
                        // Refresh Gemini file uploads for this specific API key before invoking
                        const refreshed =
                            this.geminiFileRefreshService && attachmentFetcher
                                ? await this.geminiFileRefreshService.refreshHistory(
                                      messages,
                                      attachmentFetcher,
                                      key.id,
                                  )
                                : messages;

                        filtered =
                            this.attachmentMode === "inline"
                                ? filterHistoryForInlineSize(refreshed, this.maxInlineBytes)
                                : refreshed;

                        const result = await getModel(key).invoke(filtered, {
                            timeout: timeoutMs ?? GLOBAL_MODEL_TIMEOUT_MS,
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
                                timeout: timeoutMs ?? GLOBAL_MODEL_TIMEOUT_MS,
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

                throw new AllFreeKeysExhaustedError(lastErr);
            },
        );
    }

    /**
     * Invokes the paid search model with pre-invocation Gemini file refresh.
     *
     * Unlike the free-key variant, the search model uses a single paid key with no
     * rotation. Inline attachment filtering is applied after the refresh.
     *
     * On 503 or timeout errors, if `fallbackModel` is provided, a single fallback attempt
     * is made with the same paid key and the same timeout.
     */
    private async invokePaidModelWithMiddleware<T extends BaseMessage>(
        model: InvokableModel<T>,
        fallbackModel: InvokableModel<T> | undefined,
        messages: BaseMessage[],
        attachmentFetcher: IDiscordAttachmentFetcher | undefined,
        timeoutMs?: number,
    ): Promise<{ result: T; usedFallback: boolean }> {
        return Sentry.startSpan(
            {
                name: "Invoke paid model",
                op: "llm.invoke.paid",
                attributes: { "llm.api_key_id": this.paidApiKey.id },
            },
            async (span) => {
                const refreshed =
                    this.geminiFileRefreshService && attachmentFetcher
                        ? await this.geminiFileRefreshService.refreshHistory(
                              messages,
                              attachmentFetcher,
                              this.paidApiKey.id,
                          )
                        : messages;

                const filtered =
                    this.attachmentMode === "inline"
                        ? filterHistoryForInlineSize(refreshed, this.maxInlineBytes)
                        : refreshed;

                const invokeOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
                try {
                    const result = await model.invoke(filtered, invokeOptions);
                    return { result, usedFallback: false };
                } catch (err) {
                    if (isModelFallbackError(err) && fallbackModel) {
                        this.logger.warn(
                            { errName: (err as Error).name },
                            "Paid model failed with 503/timeout; trying fallback model",
                        );
                        span.setAttribute("llm.used_fallback", true);
                        const result = await fallbackModel.invoke(filtered, invokeOptions);
                        return { result, usedFallback: true };
                    }
                    throw err;
                }
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
                config.context?.attachmentFetcher,
                this.modelTimeouts?.triageTimeoutMs,
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
                case "route_to_search":
                    // Routing sentinel: do NOT add triage message to state
                    return new Command({ goto: OrchestratorNode.SEARCH });

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
                        content: result as unknown as [] | string,
                        name: toolCall.name,
                        tool_call_id: toolCall.id ?? "",
                    }),
            );

            // Check if every entry across all tool calls is an error — if so, respond
            // programmatically rather than forwarding empty context to the general node.
            // TYPE COERCION: result union (WebsiteResultEntry[] | VideoCaptionsResultEntry[]) causes
            // TS to resolve the wrong every() overload; casting to a shared structural type is safe here.
            const allFailed = toolResults
                .flatMap(({ result }) => result as { error?: string }[])
                .every((entry) => "error" in entry);

            if (allFailed) {
                const calledTools = new Set(toolResults.map(({ toolCall }) => toolCall.name));
                const hasWebsite = calledTools.has("get_website");
                const hasVideo = calledTools.has("get_video_captions");

                // TYPE COERCION: tool_calls args typed as Record<string, unknown>; Zod schema guarantees urls: string[]
                const urlCount = (toolName: string) =>
                    toolResults
                        .filter(({ toolCall }) => toolCall.name === toolName)
                        .reduce((n, { toolCall }) => n + (toolCall.args as { urls: string[] }).urls.length, 0);

                const videoCount = hasVideo ? urlCount("get_video_captions") : 0;
                const websiteCount = hasWebsite ? urlCount("get_website") : 0;
                const videoWord = videoCount > 1 ? "videos" : "video";
                const websiteWord = websiteCount > 1 ? "websites" : "website";

                let errorContent: string;
                if (hasWebsite && hasVideo) {
                    errorContent = `I am sorry, I failed to retrieve both the captions for the ${videoWord} and the contents of the ${websiteWord} from the links you provided.`;
                } else if (hasVideo) {
                    errorContent = `I am sorry, I failed to retrieve video captions for the ${videoWord} you linked.`;
                } else {
                    errorContent = `I am sorry, I failed to retrieve the contents of the ${websiteWord} you linked.`;
                }

                span.setAttribute("agent.fetch_content.all_failed", true);
                this.logger.warn({ calledTools: [...calledTools] }, "All tool calls failed, short-circuiting to END");

                return new Command({
                    goto: END,
                    update: { messages: [...toolMessages, new AIMessage(errorContent)], isRetryable: true },
                });
            }

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
    ): Promise<{ messages: BaseMessage[]; isRetryable: boolean }> {
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
                config.context?.attachmentFetcher,
                this.modelTimeouts?.generalTimeoutMs,
            );
            return { messages: [response], isRetryable: usedFallback };
        });
    }

    /**
     * Search agent node: generates an answer using the Google-Search-grounded model.
     * Always uses the paid API key — Google Search grounding is a paid-only feature.
     */
    private async searchNode(
        state: GraphState,
        config: NodeConfig,
    ): Promise<{ messages: BaseMessage[]; isRetryable: boolean }> {
        return Sentry.startSpan({ name: "Search agent node", op: "agent.node.search" }, async () => {
            config.context?.onStatusUpdate?.({
                type: AgentStatusType.SEARCHING,
            });
            const messages: BaseMessage[] = [new SystemMessage(SEARCH_SYSTEM_PROMPT), ...state.messages];
            const { result: response, usedFallback } = await this.invokePaidModelWithMiddleware(
                this.searchProvider.get(this.paidApiKey),
                this.searchProvider.getFallback(this.paidApiKey),
                messages,
                config.context?.attachmentFetcher,
                this.modelTimeouts?.searchTimeoutMs,
            );
            return { messages: [response], isRetryable: usedFallback };
        });
    }
}
