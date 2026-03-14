import type { BaseMessage, HumanMessage } from "@langchain/core/messages";
import * as Sentry from "@sentry/bun";
import type { IMessageRepository } from "../domain/message/IMessageRepository.ts";
import type { MessageIntent } from "../domain/message/MessageIntent.ts";
import type { IAgentOrchestrator } from "./ports/IAgentOrchestrator.ts";
import type { IDiscordAttachmentRefetcher } from "./ports/IDiscordAttachmentRefetcher.ts";
import type { OnStatusUpdate } from "./types/AgentStatus.ts";
import type { Logger } from "./types/Logger.ts";

/**
 * Application use case: re-run the LLM orchestration for a previously saved human message.
 *
 * Used by the Retry button handler when the human message row already exists in the DB
 * (Scenario A), meaning the failure occurred in the orchestrator rather than during
 * message construction or persistence. Skips attachment download/upload and DB save —
 * both have already succeeded. Gemini file URIs stored in the human message are refreshed
 * by the orchestrator's GeminiFileRefreshService internally if needed.
 *
 * Returns the same shape as {@link HandleDiscordMessage.handle} so the gateway can
 * share the same post-processing path (pagination, saveBotResponse, button attachment).
 */
export class RetryOrchestration {
    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly orchestrator: IAgentOrchestrator,
        private readonly logger: Logger,
    ) {}

    /**
     * Re-invoke the orchestrator using the saved conversation chain up to and including
     * the given human message.
     *
     * @param params.humanDiscordMessageId - Discord snowflake of the human message to retry from
     * @param params.intent - The message intent (re-derived by the caller from the original Discord message)
     * @param params.onStatusUpdate - Optional callback for live status updates
     * @param params.attachmentRefetcher - Optional Discord attachment fetcher for Gemini file refresh
     */
    async execute(params: {
        humanDiscordMessageId: string;
        intent: MessageIntent;
        onStatusUpdate?: OnStatusUpdate;
        attachmentRefetcher?: IDiscordAttachmentRefetcher;
    }): Promise<{
        response: string;
        newMessages: BaseMessage[];
        isFailure?: boolean;
        isRetryable?: boolean;
    }> {
        try {
            return await Sentry.startSpan(
                {
                    name: "Retry orchestration",
                    op: "app.message.retry",
                    attributes: { "discord.message_id": params.humanDiscordMessageId },
                },
                async (span) => {
                    // Fetch the full chain up to and including the human message.
                    // The recursive CTE walks upward, so the human message is the last (most recent) row.
                    const chain = await this.messageRepo.fetchChain(params.humanDiscordMessageId);

                    if (chain.length === 0) {
                        this.logger.warn(
                            { humanDiscordMessageId: params.humanDiscordMessageId },
                            "Retry: chain is empty — human message row not found",
                        );
                        return {
                            response: "Sorry, I could not find the original message to retry.",
                            newMessages: [],
                            isFailure: true,
                            isRetryable: false,
                        };
                    }

                    const humanMsgRecord = chain[chain.length - 1];
                    if (!humanMsgRecord || humanMsgRecord.role !== "human") {
                        this.logger.warn(
                            {
                                humanDiscordMessageId: params.humanDiscordMessageId,
                                role: humanMsgRecord?.role,
                            },
                            "Retry: last message in chain is not a human message",
                        );
                        return {
                            response: "Sorry, I could not find the original message to retry.",
                            newMessages: [],
                            isFailure: true,
                            isRetryable: false,
                        };
                    }

                    const priorRecords = chain.slice(0, -1);
                    const history = this.orchestrator.buildHistory(priorRecords);

                    // Deserialize the human message record. buildHistory returns BaseMessage[];
                    // the human message row always deserializes to a single HumanMessage.
                    // TYPE COERCION: buildHistory returns BaseMessage[] without narrowing to HumanMessage.
                    // The record's role === "human" guarantees the deserialized type is HumanMessage.
                    const humanMsg = this.orchestrator.buildHistory([humanMsgRecord])[0] as HumanMessage;

                    span.setAttributes({
                        "app.history_length": history.length,
                        "app.intent": params.intent,
                    });

                    this.logger.debug(
                        {
                            humanDiscordMessageId: params.humanDiscordMessageId,
                            historyLength: history.length,
                            intent: params.intent,
                        },
                        "Retrying orchestration with saved chain",
                    );

                    const { content, newMessages } = await this.orchestrator.process(
                        history,
                        humanMsg,
                        params.intent,
                        params.onStatusUpdate,
                        params.attachmentRefetcher,
                    );

                    if (!content) {
                        this.logger.warn(
                            { humanDiscordMessageId: params.humanDiscordMessageId },
                            "Orchestrator returned empty content on retry",
                        );
                        return {
                            response: "Sorry, I encountered an error processing your request.",
                            newMessages,
                            isFailure: true,
                            isRetryable: true,
                        };
                    }

                    return { response: content, newMessages };
                },
            );
        } catch (err) {
            this.logger.error(
                { err, humanDiscordMessageId: params.humanDiscordMessageId },
                "Retry orchestration failed",
            );
            Sentry.captureException(err);
            return {
                response: "Sorry, I encountered an error processing your request.",
                newMessages: [],
                isFailure: true,
                isRetryable: true,
            };
        }
    }
}
