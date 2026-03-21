/**
 * Standalone script to register Discord application commands without starting the bot.
 * Useful during development when adding or modifying commands.
 *
 * Usage: bun run commands:register
 */

import { DiscordClient } from "../../src/infrastructure/discord/DiscordClient.ts";
import { DiscordCommandRegistry } from "../../src/infrastructure/discord/DiscordCommandRegistry.ts";
import { createLogger } from "../../src/infrastructure/logging/logger.ts";

const logger = createLogger(process.env.LOG_LEVEL?.toLowerCase() ?? "info", false);

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) {
    logger.error("DISCORD_TOKEN is not set");
    process.exit(1);
}
if (!clientId) {
    logger.error("DISCORD_CLIENT_ID is not set");
    process.exit(1);
}

const discordClient = new DiscordClient(token, logger.child({ module: "discord-client" }));
const registry = new DiscordCommandRegistry(discordClient, clientId, logger.child({ module: "discord-commands" }));

await registry.register();
