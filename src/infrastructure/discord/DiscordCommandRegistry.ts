import { sleep } from "bun";
import { ApplicationCommandType, REST, Routes } from "discord.js";
import {
    EXPORT_HTML_COMMAND_NAME,
    EXPORT_IMAGE_COMMAND_NAME,
    SUMMARIZE_COMMAND_NAME,
} from "../../application/shared/tokens.ts";
import type { Logger } from "../../application/types/Logger.ts";
import type { DiscordClient } from "./DiscordClient.ts";

/**
 * Responsible for registering application commands (slash commands, context menu commands)
 * with the Discord API via REST. Uses the bot token from {@link DiscordClient} — no gateway
 * connection is required for registration.
 */
export class DiscordCommandRegistry {
    private readonly rest: REST;
    private static readonly commands = [
        {
            name: SUMMARIZE_COMMAND_NAME,
            type: ApplicationCommandType.Message,
        },
        {
            name: EXPORT_IMAGE_COMMAND_NAME,
            type: ApplicationCommandType.Message,
        },
        {
            name: EXPORT_HTML_COMMAND_NAME,
            type: ApplicationCommandType.Message,
        },
    ];

    constructor(
        discordClient: DiscordClient,
        private readonly clientId: string,
        private readonly logger: Logger,
    ) {
        this.rest = new REST().setToken(discordClient.token);
    }

    /**
     * Registers all application commands globally.
     * Safe to call on every startup — Discord deduplicates identical registrations.
     * Retries up to 3 times with a 1-minute delay between attempts; throws on final failure.
     */
    async register(): Promise<void> {
        this.logger.info({ count: DiscordCommandRegistry.commands.length }, "Registering Discord application commands");

        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this.rest.put(Routes.applicationCommands(this.clientId), {
                    body: DiscordCommandRegistry.commands,
                });
                this.logger.info("Discord application commands registered");
                return;
            } catch (err) {
                if (attempt < maxAttempts) {
                    this.logger.warn(
                        { err, attempt },
                        "Failed to register Discord application commands, retrying in 1 minute",
                    );
                    await sleep(60_000);
                } else {
                    this.logger.error({ err }, "Failed to register Discord application commands after all retries");
                    throw err;
                }
            }
        }
    }
}
