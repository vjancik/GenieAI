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
import { AppError } from "../../domain/errors/AppError.ts";
import type { DiscordMessage } from "../../domain/message/Message.ts";
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
            content: (kwargs.content as Record<string, unknown>[]).filter(
                // TODO: this should be its own predicate function somewhere else
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
export function extractContent(response: BaseMessage): string {
    if (typeof response.content === "string") {
        return response.content;
    }
    // For structured content arrays, join all non-thought text parts
    return response.content
        .filter(isVisibleTextPart)
        .map((part) => part.text)
        .join("");
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
