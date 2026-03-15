import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import type { IMessagePageRepository, MessagePage } from "../../domain/message/MessagePage.ts";
import { splitMarkdown } from "../formatters/markdownSplitter.ts";
import { llmTextToDiscordText } from "../formatters/textTransformers.ts";
import type { Logger } from "../types/Logger.ts";

/** Parameters for {@link GetNextPageUseCase.execute}. */
export interface GetNextPageUseCaseParams {
    /** Discord snowflake of the bot message currently showing the Next Page button. */
    discordMessageId: string;
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
    /** Primary key of the {@link MessagePage} row that was looked up. */
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
 * Fetches the stored LangChain messages for the given bot message from the DB,
 * extracts the visible text from the last message, applies `llmTextToDiscordText`
 * to produce the same string that was originally paginated, then uses the stored
 * `endOffset` from `message_pages` to extract the next page.
 *
 * Returns `null` when no pending page state exists (e.g. the user clicked a stale button).
 */
export class GetNextPageUseCase {
    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly messagePageRepo: IMessagePageRepository,
        private readonly logger: Logger,
    ) {}

    /**
     * Execute the use case.
     *
     * @param params - The Discord message ID of the bot message with the Next Page button
     * @returns The next page result, or null if the page state is missing/stale
     */
    async execute(params: GetNextPageUseCaseParams): Promise<GetNextPageResult | null> {
        const { discordMessageId } = params;

        // Step 1: Look up the pending page state
        const pageState = await this.messagePageRepo.findByDiscordMessageId(discordMessageId);
        if (!pageState) {
            this.logger.debug({ discordMessageId }, "No pending page state found — stale button click");
            return null;
        }

        // Step 2: Fetch the stored messages row to get the LangChain message JSON.
        // firstPageMessageId always points to the first page's messages row regardless
        // of which page number this page state represents — the LangChain content lives there.
        const msgRecord = await this.messageRepo.findById(pageState.firstPageMessageId);
        if (!msgRecord) {
            this.logger.warn(
                { discordMessageId, firstPageMessageId: pageState.firstPageMessageId },
                "Message record not found for first page of paginated bot message",
            );
            return null;
        }

        // Step 3: Extract visible text from the last LangChain message in the stored array.
        // The last message is the final AI response (triage → tool → final or direct general).
        const lastMsgJson = msgRecord.langchainMessages.at(-1);
        if (!lastMsgJson) {
            this.logger.warn({ discordMessageId }, "langchainMessages array is empty for bot message");
            return null;
        }

        const rawText = extractTextFromMessageJson(lastMsgJson);
        // Re-apply the same transformation used when the original response was sent
        const fullDiscordText = llmTextToDiscordText(rawText);

        // Step 4: Extract the next page, continuing any open code block from the previous page
        const { currentPage, totalPages, endOffset, endedInCodeBlock, codeBlockType } = pageState;
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
            pageStateId: pageState.id,
            firstPageMessageId: pageState.firstPageMessageId,
            endedInCodeBlock: nextEndedInCodeBlock,
            codeBlockType: nextCodeBlockType,
        };
    }
}
