import { config } from './config/env';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DiscordAttachmentManager } from './infrastructure/discord/discord-attachment-manager';
import { SendMessageUseCase } from './core/application/use-cases/send-message.use-case';
import { GoogleGenAIAdapter } from './infrastructure/ai/google-genai-adapter';
import { PostgresChatRepository } from './infrastructure/database/postgres-chat-repo';
import { PostgresDiscordMessageMappingRepository } from './infrastructure/database/postgres-discord-message-mapping-repo';
import { PostgresDiscordMessagePageRepository } from './infrastructure/database/postgres-discord-message-page-repo';
import { GetNextMessagePageUseCase } from './core/application/use-cases/get-next-message-page.use-case';
import { DiscordBot } from './interfaces/discord';
import { PinoLogger } from './infrastructure/logging/pino-logger';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

async function main() {
    const logger = new PinoLogger(config.logging.level, config.logging.format, config.logging.useColor);

    logger.info('Starting AI Agent Backend...');

    // 0. Initialize Database
    const pool = new pg.Pool({
        connectionString: config.database.url,
    });
    const db = drizzle(pool);

    // 1. Initialize Infrastructure - DB Repos
    const chatRepo = new PostgresChatRepository(db);
    const discordMessageMappingRepo = new PostgresDiscordMessageMappingRepository(db);
    const discordMessagePageRepo = new PostgresDiscordMessagePageRepository(db);

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    const attachmentManager = new DiscordAttachmentManager(client, chatRepo, logger);
    const aiAdapter = new GoogleGenAIAdapter(attachmentManager, logger);

    const sendMessageUseCase = new SendMessageUseCase(chatRepo, aiAdapter, logger);
    const getNextMessagePageUseCase = new GetNextMessagePageUseCase(discordMessagePageRepo, chatRepo);

    // 3. Initialize Interface Layer
    const discordBot = new DiscordBot(
        client,
        sendMessageUseCase,
        getNextMessagePageUseCase,
        chatRepo,
        discordMessageMappingRepo,
        discordMessagePageRepo,
        logger
    );

    // 4. Start Application
    try {
        // Check if token is present, otherwise warn but don't crash if just testing
        if (config.discord.token) {
            await discordBot.start(config.discord.token);
        } else {
            logger.warn('WARNING: DISCORD_TOKEN is not set in .env. Bot will not connect to Discord.');
            logger.info('Mock setup is complete. To test real discord connection, add DISCORD_TOKEN to .env');
        }
    } catch (error) {
        logger.fatal('Failed to start application:', error);
        process.exit(1);
    }
}

main();
