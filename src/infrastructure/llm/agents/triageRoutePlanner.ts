import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { CONTENT_TOOLS } from "../../../application/types/ToolName.ts";
import { type AnsweringNode, OrchestratorNode } from "./orchestratorNode.ts";

/** Why a {@link TriagePlan} routes where it does, for logging and tracing. */
export const TriageOutcome = {
    /** Triage requested tools that must run before the answering node. */
    TOOL_CALLS: "tool_calls",
    /** Triage only picked an answering node, through a routing sentinel. */
    SENTINEL: "sentinel",
    /** Triage made no tool call at all. */
    NO_TOOL_CALL: "no_tool_call",
    /** Every URL triage asked for is already in the conversation history. */
    ALREADY_FETCHED: "already_fetched",
    /** Triage only called tools this application neither executes nor routes on. */
    UNKNOWN_TOOL: "unknown_tool",
} as const;

export type TriageOutcome = (typeof TriageOutcome)[keyof typeof TriageOutcome];

/** The routing decision derived from a triage response. */
export interface TriagePlan {
    /** The node that answers the request, after the tool calls ran (if any). */
    answerNode: AnsweringNode;
    outcome: TriageOutcome;
    /**
     * The tool calls to execute before answering, keyed by the triage call each one stems from.
     * A value is its key when the call runs unchanged, or a rewritten copy when some of its URLs
     * were dropped. Empty when the request goes straight to the answering node.
     */
    toolCalls: Map<ToolCall, ToolCall>;
}

/**
 * Scans the message history for ToolMessages from content-fetching tools and
 * collects all URLs that were successfully fetched (i.e. the result entry has
 * no `error` field).
 *
 * Results that aren't a JSON array of entries are skipped rather than rejected: persisted rows
 * may predate the current result shapes, and missing one only costs a redundant fetch.
 *
 * @returns A Set of keys in the format `"tool_name:url"`, so that a new triage tool call can be
 *   checked against already-fetched content
 */
export function collectFetchedUrls(messages: BaseMessage[]): Set<string> {
    const fetched = new Set<string>();

    for (const msg of messages) {
        if (!(msg instanceof ToolMessage) || !msg.name || !CONTENT_TOOLS.has(msg.name)) continue;

        let entries: unknown;
        try {
            entries = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        } catch {
            continue;
        }
        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
            // Only collect successful results — entries with an `error` field are failures
            if (
                entry !== null &&
                typeof entry === "object" &&
                "url" in entry &&
                typeof entry.url === "string" &&
                !("error" in entry)
            ) {
                fetched.add(`${msg.name}:${entry.url}`);
            }
        }
    }

    return fetched;
}

/**
 * Returns the content tool call to run once already-fetched URLs are removed: the call itself
 * when nothing was fetched before, a copy with the remaining URLs, or null when none remain.
 */
function withoutFetchedUrls(toolCall: ToolCall, alreadyFetched: ReadonlySet<string>): ToolCall | null {
    const urls: unknown = toolCall.args.urls;
    // Malformed arguments are left for the tool's own schema validation to reject
    if (!Array.isArray(urls)) return toolCall;

    const remaining = urls.filter((url) => !alreadyFetched.has(`${toolCall.name}:${url}`));
    if (remaining.length === urls.length) return toolCall;
    if (remaining.length === 0) return null;
    return { ...toolCall, args: { ...toolCall.args, urls: remaining } };
}

/**
 * Decides which node answers the request of a triage response, and which of its tool calls to
 * execute first.
 *
 * The two are independent. Every executable tool call runs, except for content tool URLs that
 * are already in history, which are not fetched again. The first recognized routing sentinel
 * picks the answering node, whether or not tools run before it; without one, the general node
 * answers. Unknown tools are ignored.
 *
 * @param toolCalls - The tool calls of the triage response, in the order the model made them
 * @param executableTools - Names of the tools the tools node is able to run
 * @param sentinelRoutes - The answering node of each routing sentinel that can be followed
 * @param alreadyFetched - Keys of content already in history, see {@link collectFetchedUrls}
 */
export function planTriageRoute(
    toolCalls: ToolCall[],
    executableTools: ReadonlySet<string>,
    sentinelRoutes: ReadonlyMap<string, AnsweringNode>,
    alreadyFetched: ReadonlySet<string>,
): TriagePlan {
    const sentinelNode = toolCalls.map((tc) => sentinelRoutes.get(tc.name)).find((node) => node !== undefined);
    const answerNode = sentinelNode ?? OrchestratorNode.GENERAL;
    const plan = (outcome: TriageOutcome, planned = new Map<ToolCall, ToolCall>()): TriagePlan => ({
        answerNode,
        outcome,
        toolCalls: planned,
    });

    if (toolCalls.length === 0) return plan(TriageOutcome.NO_TOOL_CALL);

    const executableCalls = toolCalls.filter((tc) => executableTools.has(tc.name));
    if (executableCalls.length === 0) {
        return plan(sentinelNode === undefined ? TriageOutcome.UNKNOWN_TOOL : TriageOutcome.SENTINEL);
    }

    const planned = new Map<ToolCall, ToolCall>();
    for (const toolCall of executableCalls) {
        const toRun = CONTENT_TOOLS.has(toolCall.name) ? withoutFetchedUrls(toolCall, alreadyFetched) : toolCall;
        if (toRun !== null) planned.set(toolCall, toRun);
    }

    return planned.size === 0 ? plan(TriageOutcome.ALREADY_FETCHED) : plan(TriageOutcome.TOOL_CALLS, planned);
}
