import * as Sentry from "@sentry/bun";
import { Events, MessageFlags } from "discord.js";
import type { IChatClientMessage } from "../../application/ports/chat/IChatClient.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { HandleChatMessageUseCase } from "../../application/use-cases/HandleChatMessage.ts";
import type { HandleExportUseCase } from "../../application/use-cases/HandleMessageExport.ts";
import type { HandleNextPageUseCase } from "../../application/use-cases/HandleMessageNextPage.ts";
import type { HandleRetryUseCase } from "../../application/use-cases/HandleMessageRetry.ts";
import type { HandleSummarizeUseCase } from "../../application/use-cases/HandleMessageSummarize.ts";
import { DiscordClientButtonInteraction } from "./adapters/DiscordClientButtonInteraction.ts";
import { DiscordClientContextMenuInteraction } from "./adapters/DiscordClientContextMenuInteraction.ts";
import { DiscordClientMessage } from "./adapters/DiscordClientMessage.ts";
import type { DiscordClient } from "./DiscordClient.ts";
import {
    EXPORT_HTML_COMMAND_NAME,
    EXPORT_IMAGE_COMMAND_NAME,
    SUMMARIZE_COMMAND_NAME,
} from "./DiscordCommandRegistry.ts";
import type { RateLimiter } from "./RateLimiter.ts";

/** Custom ID for the Retry button — needed only for event routing in this class. */
const RETRY_BUTTON_ID = "retry_mention";

/** Custom ID for the Next Page button — needed only for event routing in this class. */
const NEXT_PAGE_BUTTON_ID = "next_page";

/** Custom ID for the Render button — needed only for event routing in this class. */
const RENDER_BUTTON_ID = "render_image";

/**
 * Manages Discord event dispatching for incoming messages and button interactions.
 *
 * Lifecycle (start/stop) is delegated to the injected {@link DiscordClient}, which
 * is solely responsible for the discord.js Client connection. The gateway saves a
 * direct reference to the underlying discord.js Client for use in event handlers.
 *
 * All business logic has been moved to dedicated use cases; the gateway is now a
 * pure event dispatcher.
 */
export class DiscordGateway {
    /** Raw discord.js Client — used only for event registration in this class. */
    private readonly client: DiscordClient["client"];

    /** Set to true on graceful shutdown — prevents new handlers from starting. */
    private shutdownPending = false;
    /** Monotonically-increasing key for tracking in-flight handler promises. */
    private handlerCounter = 0;
    /** Tracks all currently in-flight async handlers; entries are removed on completion. */
    private readonly inFlightHandlers = new Map<number, Promise<void>>();

    constructor(
        discordClient: DiscordClient,
        private readonly handleChatMessageUseCase: HandleChatMessageUseCase,
        private readonly logger: Logger,
        private readonly handleNextPageUseCase: HandleNextPageUseCase,
        private readonly handleRetryUseCase: HandleRetryUseCase,
        private readonly handleSummarizeUseCase: HandleSummarizeUseCase,
        private readonly handleExportUseCase: HandleExportUseCase,
        private readonly rateLimiter: RateLimiter,
    ) {
        this.client = discordClient.client;
        this.registerEventHandlers();
    }

    private registerEventHandlers(): void {
        this.client.on(Events.MessageCreate, (message) => {
            this.trackHandler(this.handleMessageCreate(new DiscordClientMessage(message)));
        });

        this.client.on(Events.InteractionCreate, (interaction) => {
            if (this.shutdownPending && !interaction.isAutocomplete()) {
                void interaction
                    .reply({ content: "*A restart is pending, try again later.*", flags: MessageFlags.Ephemeral })
                    .catch(() => {});
                return;
            }

            if (interaction.isMessageContextMenuCommand()) {
                const wrapped = new DiscordClientContextMenuInteraction(interaction);
                if (interaction.commandName === SUMMARIZE_COMMAND_NAME) {
                    this.trackHandler(this.handleSummarizeUseCase.execute(wrapped));
                } else if (interaction.commandName === EXPORT_HTML_COMMAND_NAME) {
                    this.trackHandler(this.handleExportUseCase.handleExportHtml(wrapped));
                } else if (interaction.commandName === EXPORT_IMAGE_COMMAND_NAME) {
                    this.trackHandler(this.handleExportUseCase.handleExportImage(wrapped));
                }
                return;
            }

            if (!interaction.isButton()) return;
            const wrapped = new DiscordClientButtonInteraction(interaction);
            if (interaction.customId === RETRY_BUTTON_ID) {
                this.trackHandler(this.handleRetryUseCase.execute(wrapped));
            } else if (interaction.customId === NEXT_PAGE_BUTTON_ID) {
                this.trackHandler(this.handleNextPageUseCase.execute(wrapped));
            } else if (interaction.customId === RENDER_BUTTON_ID) {
                this.trackHandler(this.handleExportUseCase.handleRender(wrapped));
            }
        });

        this.client.on(Events.Error, (err) => {
            this.logger.error({ err }, "Discord client error");
            Sentry.captureException(err);
        });
    }

    /**
     * Registers an in-flight handler promise so {@link gracefulShutdown} can await it.
     * The entry is removed from the map once the promise settles.
     */
    private trackHandler(promise: Promise<void>): void {
        const id = this.handlerCounter++;
        this.inFlightHandlers.set(
            id,
            promise.finally(() => this.inFlightHandlers.delete(id)),
        );
    }

    /**
     * Prevents new handlers from starting and waits for all in-flight handlers to settle.
     * Called during graceful shutdown before the process exits.
     */
    async gracefulShutdown(): Promise<void> {
        this.shutdownPending = true;
        this.logger.info({ inFlight: this.inFlightHandlers.size }, "Waiting for in-flight handlers to complete");
        await Promise.allSettled(this.inFlightHandlers.values());
        this.logger.info("All in-flight handlers completed");
    }

    async handleMessageCreate(message: IChatClientMessage, retriesLeft?: number | null): Promise<void> {
        const rateLimit = this.rateLimiter.check(message.authorId);

        await this.handleChatMessageUseCase.execute({
            message,
            shutdownPending: this.shutdownPending,
            isRateLimited: !rateLimit.allowed,
            retriesLeft,
            interactionType: "message_create",
        });
    }
}
