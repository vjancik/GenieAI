import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { Logger } from "../../../application/types/Logger.ts";
import { isToolName, ToolName } from "../../../application/types/ToolName.ts";
import { AppError } from "../../../domain/errors/AppError.ts";
import { TavilySearchResultSchema } from "../tools/tavilySearchTool.ts";

// Per-entry result shapes, mirroring WebsiteResultEntry, VideoCaptionsResultEntry and the Tavily
// result schema. Validated rather than cast because persisted rows may predate the current shapes.
const WebsiteResultsSchema = z.array(
    z.union([
        z.object({ url: z.string(), pageContents: z.string() }),
        z.object({ url: z.string(), error: z.string() }),
    ]),
);

const VideoMetadataShape = { url: z.string(), title: z.string().optional(), author: z.string().optional() };
const VideoCaptionsResultsSchema = z.array(
    z.union([
        z.object({ ...VideoMetadataShape, videoCaptions: z.string() }),
        z.object({ ...VideoMetadataShape, error: z.string() }),
    ]),
);

const WebSearchResultsSchema = z.array(TavilySearchResultSchema);

/** Label used when a tool result cannot be rendered by its own formatter. */
const FALLBACK_LABEL = "Retrieved context:";

/** Separates the rendered results of consecutive entries and tool calls. */
const SECTION_SEPARATOR = "\n\n";

/**
 * Renders a parsed tool result as plain text, or returns null when the result does not match
 * the tool's expected shape (the caller then falls back to the raw content).
 */
type ToolResultFormatter = (result: unknown) => string | null;

function formatWebsiteResults(result: unknown): string | null {
    const parsed = WebsiteResultsSchema.safeParse(result);
    if (!parsed.success) return null;
    return parsed.data
        .map((entry) =>
            "pageContents" in entry
                ? `Website contents of ${entry.url}:\n${entry.pageContents}`
                : // Website error messages already lead with the URL
                  `Failed to retrieve website contents: ${entry.error}`,
        )
        .join(SECTION_SEPARATOR);
}

/** Describes a video by its title and author when known, always including the URL. */
function describeVideo({ url, title, author }: { url: string; title?: string; author?: string }): string {
    if (title === undefined) return url;
    return `"${title}"${author === undefined ? "" : ` by ${author}`} (${url})`;
}

function formatVideoCaptionsResults(result: unknown): string | null {
    const parsed = VideoCaptionsResultsSchema.safeParse(result);
    if (!parsed.success) return null;
    return parsed.data
        .map((entry) =>
            "videoCaptions" in entry
                ? `Video captions of ${describeVideo(entry)}:\n${entry.videoCaptions}`
                : `Failed to retrieve video captions of ${describeVideo(entry)}: ${entry.error}`,
        )
        .join(SECTION_SEPARATOR);
}

function formatWebSearchResults(result: unknown): string | null {
    const parsed = WebSearchResultsSchema.safeParse(result);
    if (!parsed.success) return null;
    if (parsed.data.length === 0) return "Web search context:\nThe web search returned no results.";
    const sources = parsed.data.map((entry, i) => `[${i + 1}] ${entry.title} (${entry.url})\n${entry.content}`);
    return `Web search context:\n${sources.join(SECTION_SEPARATOR)}`;
}

/** Exhaustive over {@link ToolName}, so a newly added tool must define how its results are rendered. */
const TOOL_RESULT_FORMATTERS: Record<ToolName, ToolResultFormatter> = {
    [ToolName.GET_WEBSITE]: formatWebsiteResults,
    [ToolName.GET_VIDEO_CAPTIONS]: formatVideoCaptionsResults,
    [ToolName.WEB_SEARCH]: formatWebSearchResults,
};

/**
 * Parses a ToolMessage's JSON string content, returning null when it is not valid JSON.
 * Non-string (content block) content is returned as is and left to the formatter's schema.
 */
function parseToolContent(content: ToolMessage["content"]): unknown {
    if (typeof content !== "string") return content;
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Renders a single ToolMessage as plain text. Unknown tools and results that don't match their
 * tool's shape are forwarded verbatim under a neutral label, so no retrieved context is lost.
 */
function formatToolMessage(message: ToolMessage, logger: Logger): string {
    const formatted =
        message.name !== undefined && isToolName(message.name)
            ? TOOL_RESULT_FORMATTERS[message.name](parseToolContent(message.content))
            : null;
    if (formatted !== null) return formatted;

    logger.warn(
        { toolName: message.name, toolCallId: message.tool_call_id },
        "Unrecognized tool result in history, forwarding its raw content",
    );
    const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${FALLBACK_LABEL}\n${raw}`;
}

/** Result of {@link flattenToolExchanges}. */
interface FlattenedHistory {
    /** The rewritten message array, safe to send to the model. */
    messages: BaseMessage[];
    /** Number of tool exchanges that were replaced by a HumanMessage. */
    exchangeCount: number;
}

/**
 * Rewrites every tool exchange in a message history into a plain HumanMessage holding the
 * rendered tool results, so the model never sees a past function call.
 *
 * WORKAROUND: Gemini Flash models tend to hallucinate tool calls when the history contains
 * earlier tool calls, even with a never-callable tool bound and VALIDATED calling mode.
 * The result is meant for a single model invocation only and must not be persisted:
 * the original messages (including thought signatures) stay in graph state and in the DB.
 *
 * An exchange is an AIMessage carrying tool calls followed by all directly subsequent
 * ToolMessages. A HumanMessage is used because the history must not end on a model turn;
 * the Gemini converter merges it with an adjacent user turn, so roles still alternate.
 * The AIMessage is dropped entirely, as its text and thought signature can leak the call.
 *
 * Mirrors the Gemini API's own validation by throwing on malformed exchanges, so behavior
 * is the same with or without the rewrite.
 *
 * @param messages - The history to rewrite; never mutated
 * @param logger - Used to report tool results that had to be forwarded unformatted
 * @throws AppError (`ORCHESTRATOR_INVALID_TOOL_HISTORY`) when an AIMessage's tool call count
 *   does not match the number of ToolMessages after it, or a ToolMessage has no preceding call
 */
export function flattenToolExchanges(messages: BaseMessage[], logger: Logger): FlattenedHistory {
    const flattened: BaseMessage[] = [];
    let exchangeCount = 0;
    let i = 0;

    while (i < messages.length) {
        // TYPE COERCION: the loop condition guarantees the index is in bounds.
        const message = messages[i] as BaseMessage;
        i++;

        if (message instanceof ToolMessage) {
            throw new AppError(
                "ORCHESTRATOR_INVALID_TOOL_HISTORY",
                `ToolMessage (${message.name ?? "unnamed"}) in history has no preceding tool call`,
            );
        }

        const toolCallCount = message instanceof AIMessage ? (message.tool_calls?.length ?? 0) : 0;
        if (toolCallCount === 0) {
            flattened.push(message);
            continue;
        }

        // Consume every directly subsequent ToolMessage as part of this exchange
        const toolMessages: ToolMessage[] = [];
        for (let next = messages[i]; next instanceof ToolMessage; next = messages[i]) {
            toolMessages.push(next);
            i++;
        }

        if (toolMessages.length !== toolCallCount) {
            throw new AppError(
                "ORCHESTRATOR_INVALID_TOOL_HISTORY",
                `AIMessage with ${toolCallCount} tool call(s) is followed by ${toolMessages.length} tool response(s)`,
            );
        }

        flattened.push(
            new HumanMessage(toolMessages.map((tm) => formatToolMessage(tm, logger)).join(SECTION_SEPARATOR)),
        );
        exchangeCount++;
    }

    return { messages: flattened, exchangeCount };
}
