import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config/env';
import { GetNextMessagePageUseCase } from './core/application/use-cases/get-next-message-page.use-case';
import { SendMessageUseCase } from './core/application/use-cases/send-message.use-case';
import { HistoryService } from './core/domain/services/history-service';
import { GoogleGenAIAdapter } from './infrastructure/ai/google-genai-adapter';
import { db } from './infrastructure/database/drizzle-client';
import { PostgresChatRepository } from './infrastructure/database/postgres-chat-repo';
import { PostgresDiscordMessageMappingRepository } from './infrastructure/database/postgres-discord-message-mapping-repo';
import { PostgresDiscordMessagePageRepository } from './infrastructure/database/postgres-discord-message-page-repo';
import { DiscordAttachmentManager } from './infrastructure/discord/discord-attachment-manager';
import { UuidGenerator } from './infrastructure/identity/uuid-generator';
import { PinoLogger } from './infrastructure/logging/pino-logger';
import { DiscordBot } from './interfaces/discord';

async function main() {
	const logger = new PinoLogger(config.logging.level, config.logging.format, config.logging.useColor);

	// 1. Initialize Infrastructure Layer
	const chatRepo = new PostgresChatRepository(db);
	const discordMessageMappingRepo = new PostgresDiscordMessageMappingRepository(db);
	const discordMessagePageRepo = new PostgresDiscordMessagePageRepository(db);
	const idGenerator = new UuidGenerator();
	const historyService = new HistoryService(chatRepo);

	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
	});

	// 2. Initialize Application Layer (Use Cases + Domain Services)
	const attachmentManager = new DiscordAttachmentManager(client, chatRepo, logger);
	const aiAdapter = new GoogleGenAIAdapter(attachmentManager, logger, {
		apiKey: config.ai.apiKey,
		model: config.ai.model,
		systemPrompt: config.ai.systemPrompt,
	});
	const sendMessageUseCase = new SendMessageUseCase(chatRepo, aiAdapter, historyService, idGenerator, logger);
	const getNextMessagePageUseCase = new GetNextMessagePageUseCase(discordMessagePageRepo, chatRepo);

	// 3. Initialize Interface Layer
	const discordBot = new DiscordBot(
		client,
		sendMessageUseCase,
		getNextMessagePageUseCase,
		chatRepo,
		discordMessageMappingRepo,
		discordMessagePageRepo,
		idGenerator,
		logger,
	);

	await discordBot.start(config.discord.token);
}

main().catch((err) => {
	console.error('Fatal error during startup:', err);
	process.exit(1);
});
