import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
    AIMessageChunk,
    ChatMessage,
    ChatMessageChunk,
    FunctionMessage,
    FunctionMessageChunk,
    HumanMessage,
    HumanMessageChunk,
    RemoveMessage,
    SystemMessage,
    SystemMessageChunk,
    ToolMessage,
    ToolMessageChunk,
} from "@langchain/core/messages";
import type { PersistedChatMessage } from "../../domain/entities/Message.ts";
import { AppError } from "../../domain/errors/AppError.ts";
import type { ChatFileAttachment } from "../ports/chat/IChatClientMessage.ts";
import type { Logger } from "../types/Logger.ts";

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
            content: (kwargs.content as Record<string, unknown>[]).filter(isNotThoughtChunk),
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

    switch (className) {
        case "HumanMessage":
            return new HumanMessage(kwargs);
        case "HumanMessageChunk":
            return new HumanMessageChunk(kwargs);
        case "AIMessage":
            return new AIMessage(kwargs);
        case "AIMessageChunk":
            return new AIMessageChunk(kwargs);
        case "ToolMessage":
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ToolMessage's strict constructor union type; double cast through unknown is required.
            return new ToolMessage(kwargs as unknown as ConstructorParameters<typeof ToolMessage>[0]);
        case "ToolMessageChunk":
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ToolMessageChunk's strict constructor union type; double cast through unknown is required.
            return new ToolMessageChunk(kwargs as unknown as ConstructorParameters<typeof ToolMessageChunk>[0]);
        case "ChatMessage":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ChatMessage's strict constructor union type; double cast through unknown is required.
            return new ChatMessage(kwargs as unknown as ConstructorParameters<typeof ChatMessage>[0]);
        case "ChatMessageChunk":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // ChatMessageChunk's strict constructor union type; double cast through unknown is required.
            return new ChatMessageChunk(kwargs as unknown as ConstructorParameters<typeof ChatMessageChunk>[0]);
        case "FunctionMessage":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // FunctionMessage's strict constructor union type; double cast through unknown is required.
            return new FunctionMessage(kwargs as unknown as ConstructorParameters<typeof FunctionMessage>[0]);
        case "FunctionMessageChunk":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // FunctionMessageChunk's strict constructor union type; double cast through unknown is required.
            return new FunctionMessageChunk(kwargs as unknown as ConstructorParameters<typeof FunctionMessageChunk>[0]);
        case "RemoveMessage":
            logger.warn({ className }, "Unexpected message type in history chain");
            // TYPE COERCION: kwargs is Record<string, unknown> which doesn't satisfy
            // RemoveMessage's strict constructor union type; double cast through unknown is required.
            return new RemoveMessage(kwargs as unknown as ConstructorParameters<typeof RemoveMessage>[0]);
        case "SystemMessage":
        case "SystemMessageChunk": {
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
            return className === "SystemMessageChunk" ? new SystemMessageChunk(kwargs) : new SystemMessage(kwargs);
        }
        default:
            logger.warn({ className }, "Unknown message type in history chain");
            throw new AppError("UNKNOWN_MESSAGE_TYPE", `Cannot deserialize unknown message type: ${className}`);
    }
}

/** A structured content part that is a plain text segment. */
type TextContentPart = { type: "text"; text: string };

type ExecutableCodePart = {
    type: "executableCode";
    executableCode: { language: string; code: string };
};

type CodeExecutionResultPart = {
    type: "codeExecutionResult";
    codeExecutionResult: { outcome: string; output?: string };
};

/**
 * Type guard: returns true if a content part is not a Gemini thought chunk.
 *
 * Thought chunks (`thought: true`) are internal reasoning that should be preserved
 * in storage but never shown to users. All other part types (text, executableCode,
 * codeExecutionResult, etc.) pass through.
 */
function isNotThoughtChunk(part: unknown): boolean {
    if (typeof part !== "object" || part === null) return true;
    // TYPE COERCION: part is narrowed to object but object doesn't allow index access;
    // cast to Record to read structured content fields by name.
    const p = part as Record<string, unknown>;
    return p.thought !== true;
}

/**
 * Type guard: returns true if a content part can contribute text to the extracted output.
 * Covers plain text parts, executableCode, and codeExecutionResult — all non-thought
 * part types that have a textual representation for display.
 */
function isTextExtractable(part: unknown): part is TextContentPart | ExecutableCodePart | CodeExecutionResultPart {
    if (typeof part !== "object" || part === null) return false;
    // TYPE COERCION: part is narrowed to object but object doesn't allow index access;
    // cast to Record to read the type discriminant by name.
    const p = part as Record<string, unknown>;
    return p.type === "text" || p.type === "executableCode" || p.type === "codeExecutionResult";
}

/**
 * Converts a single extractable content part to its display string.
 *
 * - `text`: returned as-is
 * - `executableCode`: rendered as a labeled markdown code block; empty code yields ""
 * - `codeExecutionResult`: rendered as a labeled block with outcome status and output; empty output yields ""
 */
function contentPartToText(part: TextContentPart | ExecutableCodePart | CodeExecutionResultPart): string {
    if (part.type === "text") return part.text;

    // if (part.type === "executableCode") {
    //     const { language, code } = part.executableCode;
    //     if (!code.trim()) return "";
    //     const lang = language.toLowerCase() === "language_unspecified" ? "" : language.toLowerCase();
    //     return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`;
    // }

    // if (part.type === "codeExecutionResult") {
    //     const { output } = part.codeExecutionResult;
    //     if (!output?.trim()) return "";
    //     return `\n\`\`\`\n${output.trim()}\n\`\`\`\n`;
    // }

    return "";
}

/**
 * Extracts the displayable text content from a message's content value, handling both
 * string and structured array formats. Filters out Gemini thought chunks
 * (internal reasoning marked with thought: true) which should not be shown to users,
 * while preserving them in the stored message for context continuity.
 *
 * Handles text, executableCode, and codeExecutionResult parts; other part types
 * (e.g. tool use) are ignored. Parts are joined with "" — text parts carry their own
 * whitespace, and custom-formatted blocks (executableCode, codeExecutionResult) wrap
 * themselves with leading/trailing newlines.
 *
 * Accepts the raw content value directly — either `message.content` from a LangChain
 * `BaseMessage`, or `kwargs.content` from a serialized message JSON object.
 */
export function extractContent(content: BaseMessage["content"] | unknown[]): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) return "";
    return content.filter(isNotThoughtChunk).filter(isTextExtractable).map(contentPartToText).filter(Boolean).join("");
}

/**
 * Converts persisted {@link PersistedChatMessage} records into LangChain {@link BaseMessage} objects.
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
    records: PersistedChatMessage[],
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

/** A structured content part carrying base64-encoded inline data (e.g. a generated image). */
type InlineDataPart = {
    type: "inlineData";
    inlineData: { mimeType: string; data: string };
};

function isInlineDataPart(part: unknown): part is InlineDataPart {
    if (typeof part !== "object" || part === null) return false;
    // TYPE COERCION: cast to Record to read the type discriminant by name.
    const p = part as Record<string, unknown>;
    if (p.type !== "inlineData") return false;
    const inner = p.inlineData as Record<string, unknown> | undefined;
    return typeof inner?.mimeType === "string" && typeof inner?.data === "string";
}

/**
 * Extracts all `inlineData` content parts from an array of LangChain messages and
 * converts them to Discord file attachments (Buffers decoded from base64).
 *
 * Attachments are named `attachment-<n>.<ext>` where `<ext>` is derived from the
 * MIME subtype (e.g. `image/png` → `attachment-0.png`). Only messages with array
 * content are inspected — string-content messages cannot carry inlineData parts.
 *
 * @returns A flat array of {@link ChatFileAttachment} objects ready for `ChatReplyOptions.files`.
 */
export function extractInlineDataBlocksAsAttachments(messages: BaseMessage[]): ChatFileAttachment[] {
    const attachments: ChatFileAttachment[] = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (!isInlineDataPart(part)) continue;
            const { mimeType, data } = part.inlineData;
            // Derive a file extension from the MIME subtype (e.g. "image/png" → "png").
            // Falls back to "bin" for unrecognized or missing subtypes.
            const ext = mimeType.includes("/") ? (mimeType.split("/")[1] ?? "bin") : "bin";
            attachments.push({
                attachment: Buffer.from(data, "base64"),
                name: `attachment-${attachments.length}.${ext}`,
            });
        }
    }
    return attachments;
}

/**
 * Returns a new message array where every `inlineData` content part is replaced with a
 * `{ type: "media", mimeType, url }` token block pointing at the Discord attachment that
 * was uploaded when replying.
 *
 * The `attachmentIds` array must be in the same order as the attachments produced by
 * {@link extractInlineDataBlocksAsAttachments} — each inlineData part encountered (across
 * all messages, in order) is paired with the next attachment ID from the array.
 *
 * Messages with string content, or no inlineData parts, are returned unchanged.
 */
export function replaceInlineDataBlocksWithDiscordTokenUrls(
    messages: BaseMessage[],
    attachmentIds: string[],
    messageId: string,
    channelId: string,
    guildId: string,
): BaseMessage[] {
    let attachmentIndex = 0;
    return messages.map((message) => {
        if (!Array.isArray(message.content)) return message;
        if (!message.content.some(isInlineDataPart)) return message;

        // TYPE COERCION: BaseMessage.content is typed as a readonly-ish union but is a plain
        // mutable array at runtime; cast to any[] to allow in-place element replacement.
        const content = message.content;
        for (let i = 0; i < content.length; i++) {
            const part = content[i];
            if (!isInlineDataPart(part)) continue;
            const attachmentId = attachmentIds[attachmentIndex++];
            if (attachmentId === undefined) {
                throw new AppError(
                    "INLINE_DATA_ATTACHMENT_ID_MISMATCH",
                    "Ran out of attachment IDs while replacing inlineData blocks — counts must match",
                );
            }
            content[i] = {
                type: "media",
                mimeType: part.inlineData.mimeType,
                url: `discord://${guildId}/${channelId}/${messageId}/${attachmentId}`,
            };
        }
        return message;
    });
}
