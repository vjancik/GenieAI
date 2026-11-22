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
        z.object({ url: z.string(), file: z.object({ mimeType: z.string(), name: z.string().optional() }) }),
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
 * A media block standing in for a file on the web. Its `url` is a media token: the Gemini media
 * normalizer loads the file from it before the message reaches the model.
 */
type ExternalFileBlock = { type: "media"; mimeType: string; url: string };

/** A piece of a rendered tool result: plain text, or a file to load into the conversation. */
type ToolResultPart = string | ExternalFileBlock;

/** How tool results are rendered. */
interface FlattenOptions {
    /**
     * Whether files found by the website tool are embedded as media blocks for the model to
     * read. Requires a setup that resolves such blocks (upload attachment mode); without it
     * they are mentioned in text only.
     */
    embedExternalFiles: boolean;
    /**
     * Whether only HTTPS URLs may be fetched. Files found over plain HTTP before the policy
     * was enabled are then mentioned, with the reason, rather than embedded.
     */
    httpsOnly: boolean;
}

/** Whether a URL uses plain HTTP rather than HTTPS. */
function isPlainHttpUrl(url: string): boolean {
    return url.toLowerCase().startsWith("http:");
}

/**
 * Renders a parsed tool result as text, interleaved with file blocks where the result holds
 * files, or returns null when the result does not match the tool's expected shape (the caller
 * then falls back to the raw content).
 */
type ToolResultFormatter = (result: unknown, options: FlattenOptions) => ToolResultPart[] | null;

function formatWebsiteResults(result: unknown, options: FlattenOptions): ToolResultPart[] | null {
    const parsed = WebsiteResultsSchema.safeParse(result);
    if (!parsed.success) return null;

    const parts: ToolResultPart[] = [];
    for (const entry of parsed.data) {
        if ("pageContents" in entry) {
            parts.push(`Website contents of ${entry.url}:\n${entry.pageContents}`);
        } else if ("file" in entry) {
            const description = `${entry.file.name ?? "file"}, ${entry.file.mimeType}`;
            if (options.embedExternalFiles && options.httpsOnly && isPlainHttpUrl(entry.url)) {
                parts.push(
                    `A file was found at ${entry.url} (${description}), but it was not loaded: only HTTPS URLs ` +
                        "are allowed, plain HTTP is not — this is a fixed policy, retrying will not help.",
                );
            } else if (options.embedExternalFiles) {
                parts.push(`File retrieved from ${entry.url} (${description}):`);
                parts.push({ type: "media", mimeType: entry.file.mimeType, url: entry.url });
            } else {
                parts.push(`A file was found at ${entry.url} (${description}), but its contents could not be loaded.`);
            }
        } else {
            // Website error messages already lead with the URL
            parts.push(`Failed to retrieve website contents: ${entry.error}`);
        }
    }
    return parts;
}

/** Describes a video by its title and author when known, always including the URL. */
function describeVideo({ url, title, author }: { url: string; title?: string; author?: string }): string {
    if (title === undefined) return url;
    return `"${title}"${author === undefined ? "" : ` by ${author}`} (${url})`;
}

function formatVideoCaptionsResults(result: unknown): ToolResultPart[] | null {
    const parsed = VideoCaptionsResultsSchema.safeParse(result);
    if (!parsed.success) return null;
    return parsed.data.map((entry) =>
        "videoCaptions" in entry
            ? `Video captions of ${describeVideo(entry)}:\n${entry.videoCaptions}`
            : `Failed to retrieve video captions of ${describeVideo(entry)}: ${entry.error}`,
    );
}

function formatWebSearchResults(result: unknown): ToolResultPart[] | null {
    const parsed = WebSearchResultsSchema.safeParse(result);
    if (!parsed.success) return null;
    if (parsed.data.length === 0) return ["Web search context:\nThe web search returned no results."];
    const sources = parsed.data.map((entry, i) => `[${i + 1}] ${entry.title} (${entry.url})\n${entry.content}`);
    return [`Web search context:\n${sources.join(SECTION_SEPARATOR)}`];
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
 * Renders a single ToolMessage. Unknown tools and results that don't match their tool's shape
 * are forwarded verbatim under a neutral label, so no retrieved context is lost.
 */
function formatToolMessage(message: ToolMessage, logger: Logger, options: FlattenOptions): ToolResultPart[] {
    const formatted =
        message.name !== undefined && isToolName(message.name)
            ? TOOL_RESULT_FORMATTERS[message.name](parseToolContent(message.content), options)
            : null;
    if (formatted !== null) return formatted;

    logger.warn(
        { toolName: message.name, toolCallId: message.tool_call_id },
        "Unrecognized tool result in history, forwarding its raw content",
    );
    const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return [`${FALLBACK_LABEL}\n${raw}`];
}

/**
 * Builds the HumanMessage that replaces a tool exchange.
 *
 * Without files the content is a single string. With files it is a block array, in which
 * each run of consecutive text parts forms one text block, so a file sits right after the
 * text introducing it.
 */
function toHumanMessage(parts: ToolResultPart[]): HumanMessage {
    if (parts.every((part) => typeof part === "string")) {
        return new HumanMessage(parts.join(SECTION_SEPARATOR));
    }

    const blocks: ({ type: "text"; text: string } | ExternalFileBlock)[] = [];
    let textRun: string[] = [];
    const flushText = () => {
        if (textRun.length === 0) return;
        blocks.push({ type: "text", text: textRun.join(SECTION_SEPARATOR) });
        textRun = [];
    };

    for (const part of parts) {
        if (typeof part === "string") {
            textRun.push(part);
            continue;
        }
        flushText();
        blocks.push(part);
    }
    flushText();

    return new HumanMessage({ content: blocks });
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
 * A file found by the website tool has no content in its tool result. It is rendered as a
 * media block holding the file's URL instead, which is how the file enters the conversation:
 * the block is rebuilt from the persisted tool result on every turn, and resolved to an
 * upload right before the model call.
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
 * @param options - How tool results are rendered, see {@link FlattenOptions}
 * @throws AppError (`ORCHESTRATOR_INVALID_TOOL_HISTORY`) when an AIMessage's tool call count
 *   does not match the number of ToolMessages after it, or a ToolMessage has no preceding call
 */
export function flattenToolExchanges(
    messages: BaseMessage[],
    logger: Logger,
    options: FlattenOptions = { embedExternalFiles: false, httpsOnly: false },
): FlattenedHistory {
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

        flattened.push(toHumanMessage(toolMessages.flatMap((tm) => formatToolMessage(tm, logger, options))));
        exchangeCount++;
    }

    return { messages: flattened, exchangeCount };
}
