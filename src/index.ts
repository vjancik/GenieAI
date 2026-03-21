/**
 * Composition root: wires all dependencies together and starts the application.
 *
 * This is the only place where concrete implementations are constructed and
 * injected into abstractions. All other modules depend on interfaces.
 *
 * Startup sequence:
 * 1. Load config and create logger
 * 2. Create DB connection and repositories
 * 3. Sync Gemini API keys from env → DB (assigns stable UUIDs for FK references)
 * 4. Construct lazy model providers and uploader registry
 * 5. Wire orchestrator and use case handler
 * 6. Start Discord gateway
 */
import * as Sentry from "@sentry/bun";
import { ConfigProvider } from "./application/config/AppConfig.ts";
import { GeminiApiKeySyncService } from "./application/services/GeminiApiKeySyncService.ts";
import { GeminiFileRefreshService } from "./application/services/GeminiFileRefreshService.ts";
import { GetNextPageUseCase } from "./application/use-cases/GetNextPage.ts";
import { HandleDiscordMessageUseCase } from "./application/use-cases/HandleDiscordMessage.ts";
import { FetchAttachmentDownloader } from "./infrastructure/attachments/FetchAttachmentDownloader.ts";
import { FetchDiskAttachmentDownloader } from "./infrastructure/attachments/FetchDiskAttachmentDownloader.ts";
import { GenaiFileUploaderRegistry } from "./infrastructure/attachments/GenaiFileUploaderRegistry.ts";
import { createDb } from "./infrastructure/db/connection.ts";
import { PgGetNextPageQuery } from "./infrastructure/db/queries/PgGetNextPageQuery.ts";
import { PgGeminiApiKeyRepository } from "./infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { PgGeminiFileRepository } from "./infrastructure/db/repositories/PgGeminiFileRepository.ts";
import { PgMessagePageRepository } from "./infrastructure/db/repositories/PgMessagePageRepository.ts";
import { PgMessageRepository } from "./infrastructure/db/repositories/PgMessageRepository.ts";
import { DiscordChatMessageService } from "./infrastructure/discord/DiscordChatMessageService.ts";
import { DiscordClient } from "./infrastructure/discord/DiscordClient.ts";
import { DiscordCommandRegistry } from "./infrastructure/discord/DiscordCommandRegistry.ts";
import { DiscordGateway } from "./infrastructure/discord/DiscordGateway.ts";
import { DiscordMediaService } from "./infrastructure/discord/DiscordMediaService.ts";
import { StatusMessageUpdater } from "./infrastructure/discord/StatusMessageUpdater.ts";
import { AgentOrchestrator } from "./infrastructure/llm/agents/geminiAgentOrchestrator.ts";
import { GeneralModelProvider } from "./infrastructure/llm/models/generalModel.ts";
import { SearchModelProvider } from "./infrastructure/llm/models/searchModel.ts";
import { TriageModelProvider } from "./infrastructure/llm/models/triageModel.ts";
import { RoundRobinFreeKeyProvider } from "./infrastructure/llm/RoundRobinFreeKeyProvider.ts";
import { SinglePaidKeyProvider } from "./infrastructure/llm/SinglePaidKeyProvider.ts";
import { createGetVideoCaptionsTool } from "./infrastructure/llm/tools/getVideoCaptionsTool.ts";
import { createGetWebsiteTool } from "./infrastructure/llm/tools/getWebsiteTool.ts";
import { createLogger } from "./infrastructure/logging/logger.ts";

const logger = createLogger(
    process.env.LOG_LEVEL?.toLowerCase() ?? "info",
    process.env.FILE_LOG?.toLowerCase() === "true",
);
logger.info("Starting GenieAI bot...");

const configProvider = new ConfigProvider(logger);
const config = await configProvider.get();

// Database
const db = createDb(config.databaseUrl);
const messageRepository = new PgMessageRepository(db, logger.child({ module: "repository" }));
const geminiApiKeyRepository = new PgGeminiApiKeyRepository(db, logger.child({ module: "repository:apiKey" }));
const geminiFileRepository = new PgGeminiFileRepository(db, logger.child({ module: "repository:gemini" }));

// Sync API keys from env → DB to assign stable UUIDs (required before wiring providers)
const apiKeySyncService = new GeminiApiKeySyncService(geminiApiKeyRepository, logger.child({ module: "apiKeySync" }));
const { freeKeys, paidKey } = await apiKeySyncService.sync(config.googleFreeApiKeys, config.googlePaidApiKey);

// Attachment infrastructure
const attachmentDownloader = new FetchAttachmentDownloader(logger.child({ module: "attachments" }), config);
const diskDownloader = new FetchDiskAttachmentDownloader(logger.child({ module: "attachments:disk" }), config);

// Lazy uploader registry — one GenaiFileUploader per API key, constructed on first use
const uploaderRegistry = new GenaiFileUploaderRegistry(
    [...freeKeys, paidKey],
    logger.child({ module: "attachments:uploaderRegistry" }),
    config.file,
);

// LLM tools
const getWebsiteTool = createGetWebsiteTool(logger.child({ module: "tool:website" }));
const getVideoCaptionsTool = await createGetVideoCaptionsTool(
    logger.child({ module: "tool:video" }),
    config.file.ytDlp?.httpProxy,
    config.file.ytDlp?.retries,
);

// Lazy model providers — one ChatGoogle client per (provider, apiKey) pair
const freeKeyProvider = new RoundRobinFreeKeyProvider(freeKeys);
const paidKeyProvider = new SinglePaidKeyProvider(paidKey);
const triageProvider = new TriageModelProvider({
    modelName: config.file.agent.nodes.triage.model,
    fallbackModelName: config.file.agent.nodes.triage.fallbackModel,
    thinkingLevel: config.file.agent.nodes.triage.thinkingLevel,
    includeThoughts: config.file.geminiModels.includeThoughts,
    getWebsiteTool,
    getVideoCaptionsTool,
});
const generalProvider = new GeneralModelProvider({
    modelName: config.file.agent.nodes.general.model,
    fallbackModelName: config.file.agent.nodes.general.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
});
const searchProvider = new SearchModelProvider({
    modelName: config.file.agent.nodes.search.model,
    fallbackModelName: config.file.agent.nodes.search.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
});

// Discord client lifecycle wrapper — created before use cases and gateway so both can share it
const discordClient = new DiscordClient(config.discordToken, logger.child({ module: "discord-client" }));
const commandRegistry = new DiscordCommandRegistry(
    discordClient,
    config.discordClientId,
    logger.child({ module: "discord-commands" }),
);

// Gemini file refresh service — depends on discordMediaService for re-fetching expired CDN URLs
const discordMediaService = new DiscordMediaService(discordClient);
const geminiFileRefreshService = new GeminiFileRefreshService(
    geminiFileRepository,
    uploaderRegistry,
    diskDownloader,
    discordMediaService,
    logger.child({ module: "attachments:refresh" }),
    config,
);

// Orchestrator
const agentOrchestrator = new AgentOrchestrator(
    triageProvider,
    generalProvider,
    searchProvider,
    freeKeyProvider,
    paidKeyProvider,
    getWebsiteTool,
    getVideoCaptionsTool,
    logger.child({ module: "agent-orchestrator" }),
    config,
    geminiFileRefreshService,
);

// The primary uploader for new uploads in HandleDiscordMessage uses the current free key.
// The refresh service handles uploading for other keys internally during orchestration.
const primaryUploader = uploaderRegistry.get(freeKeyProvider.currentKey.id);

// Live Discord chain fetch service — used as fallback when DB reply chain is empty
const discordChatMessageService = new DiscordChatMessageService(
    discordClient,
    config.file.discord.previousBotId,
    logger.child({ module: "discord-chat" }),
    config.file,
);

// Application use case
const handleDiscordMessageUseCase = new HandleDiscordMessageUseCase(
    messageRepository,
    agentOrchestrator,
    attachmentDownloader,
    logger.child({ module: "discord-message-use-case" }),
    config,
    diskDownloader,
    primaryUploader,
    geminiFileRepository,
    discordChatMessageService,
);

// Pagination
const messagePageRepository = new PgMessagePageRepository(db, logger.child({ module: "repository:message-pages" }));
const getNextPageQuery = new PgGetNextPageQuery(db);
const getNextPage = new GetNextPageUseCase(getNextPageQuery, logger.child({ module: "get-next-page-use-case" }));

// Discord gateway
const statusUpdater = new StatusMessageUpdater(logger.child({ module: "statusUpdater" }));
const discordGateway = new DiscordGateway(
    discordClient,
    handleDiscordMessageUseCase,
    logger.child({ module: "discord" }),
    statusUpdater,
    messagePageRepository,
    getNextPage,
    messageRepository,
    config.file,
);

// Graceful shutdown
async function shutdown() {
    logger.info("Shutting down...");
    await discordGateway.gracefulShutdown();
    discordClient.stop();
    await Sentry.flush(2000);
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason);
    logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
    Sentry.captureException(error);
    logger.error({ error }, "Uncaught exception");
    process.exit(1);
});

void commandRegistry.register().catch(() => {});
await discordClient.start();
