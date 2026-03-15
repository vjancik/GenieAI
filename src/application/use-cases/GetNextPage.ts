import type { IMessagePageRepository } from "../../domain/message/MessagePage.ts";
import { splitMarkdown } from "../formatters/markdownSplitter.ts";
import { llmTextToDiscordText } from "../formatters/textTransformers.ts";
import type { IGetNextPageQuery } from "../ports/IGetNextPageQuery.ts";
import type { Logger } from "../types/Logger.ts";

/** Parameters for {@link GetNextPageUseCase.execute}. */
export interface GetNextPageUseCaseParams {
    /** Discord snowflake of the bot message currently showing the Next Page button. */
    discordMessageId: string;
    /** Discord channel snowflake — required to resolve the unique messages row. */
    channelId: string;
    /** Discord guild snowflake, or `"@me"` for DMs. */
    guildId: string;
}

/** Result of a successful {@link GetNextPageUseCase.execute} call. */
export interface GetNextPageResult {
    /** Next page content (ready to send to Discord — no footer appended). */
    content: string;
    /** Character offset in the full text where the page after this one begins. */
    newOffset: number;
    /** 1-based page number of the page returned. */
    currentPage: number;
    /** Total number of pages in this response. */
    totalPages: number;
    /** True when this is the final page (no more Next Page button needed). */
    isLast: boolean;
    /** Primary key of the message_pages row that was looked up. */
    pageStateId: string;
    /**
     * UUID primary key of the first page bot message row in the messages table.
     * Must be passed to {@link IMessagePageRepository.save} for subsequent pages so they
     * all reference the first page's messages row (where the LangChain content lives).
     */
    firstPageMessageId: string;
    /**
     * True when this page ended mid-way through a fenced code block.
     * The next page's state row must record this so the following page can prepend
     * the matching ``` opener via {@link SplitMarkdownOptions.continuationCodeBlock}.
     */
    endedInCodeBlock: boolean;
    /**
     * Syntax label of the open code block at the boundary (e.g. `"typescript"`), or an
     * empty string for an unlabelled block. `null` when `endedInCodeBlock` is false.
     */
    codeBlockType: string | null;
}

/**
 * Extracts visible text content from a serialized LangChain BaseMessage JSON object.
 *
 * Handles both string content and structured content arrays.
 * Filters out Gemini thought chunks (parts with `thought: true`) — these are internal
 * reasoning that must be preserved in storage but must not be shown to users.
 *
 * @param json - A serialized BaseMessage as stored in the `langchain_messages` column
 * @returns The concatenated visible text, or an empty string if none found
 */
function extractTextFromMessageJson(json: Record<string, unknown>): string {
    // TYPE COERCION: json.kwargs is unknown in the generic record; cast to the known
    // LangChain serialization shape where kwargs holds named constructor arguments.
    const kwargs = json.kwargs as Record<string, unknown> | undefined;
    const content = kwargs?.content;

    if (typeof content === "string") return content;

    if (!Array.isArray(content)) return "";

    // Filter and join visible text parts (exclude thought chunks)
    return content
        .filter((part): part is { type: "text"; text: string } => {
            if (typeof part !== "object" || part === null) return false;
            // TYPE COERCION: part is narrowed to object but doesn't allow index access;
            // cast to Record to read structured content fields by name.
            const p = part as Record<string, unknown>;
            return p.type === "text" && typeof p.text === "string" && p.thought !== true;
        })
        .map((part) => part.text)
        .join("");
}

/**
 * Application use case: retrieves the next page of a paginated bot response.
 *
 * Delegates all DB access to {@link IGetNextPageQuery}, which resolves the bot
 * message Discord snowflake and fetches page state + LangChain content in a single
 * query. The use case is then responsible only for computing the page slice.
 *
 * Returns `null` when no pending page state exists (e.g. the user clicked a stale button).
 */
export class GetNextPageUseCase {
    constructor(
        private readonly getNextPageQuery: IGetNextPageQuery,
        private readonly logger: Logger,
    ) {}

    /**
     * Execute the use case.
     *
     * @param params - The Discord message ID (+ guild/channel) of the bot message with the Next Page button
     * @returns The next page result, or null if the page state is missing/stale
     */
    async execute(params: GetNextPageUseCaseParams): Promise<GetNextPageResult | null> {
        const { discordMessageId, channelId, guildId } = params;

        // Fetch page state + first-page LangChain content in one query
        const data = await this.getNextPageQuery.execute({ discordMessageId, channelId, guildId });
        if (!data) {
            this.logger.debug({ discordMessageId }, "No pending page state found — stale button click");
            return null;
        }

        // Extract visible text from the last LangChain message in the stored array.
        // The last message is the final AI response (triage → tool → final or direct general).
        const lastMsgJson = data.langchainMessages.at(-1);
        if (!lastMsgJson) {
            this.logger.warn({ discordMessageId }, "langchainMessages array is empty for bot message");
            return null;
        }

        const rawText = extractTextFromMessageJson(lastMsgJson);
        // Re-apply the same transformation used when the original response was sent
        const fullDiscordText = llmTextToDiscordText(rawText);

        // Extract the next page, continuing any open code block from the previous page
        const { currentPage, totalPages, endOffset, endedInCodeBlock, codeBlockType } = data;
        const nextPage = currentPage + 1;
        const isLast = nextPage >= totalPages;

        const continuationCodeBlock = endedInCodeBlock ? (codeBlockType ?? "") : null;
        const {
            content,
            newOffset,
            endedInCodeBlock: nextEndedInCodeBlock,
            codeBlockType: nextCodeBlockType,
        } = splitMarkdown(fullDiscordText, endOffset, 2000, { continuationCodeBlock });

        this.logger.debug({ discordMessageId, page: nextPage, totalPages, isLast }, "Computed next page content");

        return {
            content,
            newOffset,
            currentPage: nextPage,
            totalPages,
            isLast,
            pageStateId: data.pageStateId,
            firstPageMessageId: data.firstPageMessageId,
            endedInCodeBlock: nextEndedInCodeBlock,
            codeBlockType: nextCodeBlockType,
        };
    }
}
