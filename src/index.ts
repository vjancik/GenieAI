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
import { GeminiApiKeySyncService } from "./application/GeminiApiKeySyncService.ts";
import { GeminiFileRefreshService } from "./application/GeminiFileRefreshService.ts";
import { HandleDiscordMention } from "./application/HandleDiscordMention.ts";
import { FetchAttachmentDownloader } from "./infrastructure/attachments/FetchAttachmentDownloader.ts";
import { FetchDiskAttachmentDownloader } from "./infrastructure/attachments/FetchDiskAttachmentDownloader.ts";
import { GenaiFileUploaderRegistry } from "./infrastructure/attachments/GenaiFileUploaderRegistry.ts";
import { config } from "./infrastructure/config/config.ts";
import { createDb } from "./infrastructure/db/connection.ts";
import { PgGeminiApiKeyRepository } from "./infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { PgGeminiFileRepository } from "./infrastructure/db/repositories/PgGeminiFileRepository.ts";
import { PgMessageRepository } from "./infrastructure/db/repositories/PgMessageRepository.ts";
import { DiscordGateway } from "./infrastructure/discord/DiscordGateway.ts";
import { StatusMessageUpdater } from "./infrastructure/discord/StatusMessageUpdater.ts";
import { AgentOrchestrator } from "./infrastructure/llm/agentOrchestrator.ts";
import {
    GeneralModelProvider,
    SearchModelProvider,
    TriageModelProvider,
} from "./infrastructure/llm/ModelProvider.ts";
import { RoundRobinFreeKeyProvider } from "./infrastructure/llm/RoundRobinFreeKeyProvider.ts";
import { createGetVideoTranscriptionTool } from "./infrastructure/llm/tools/getVideoTranscriptionTool.ts";
import { createGetWebsiteTool } from "./infrastructure/llm/tools/getWebsiteTool.ts";
import { createLogger } from "./infrastructure/logging/logger.ts";

// All current models use this Gemini variant
const TRIAGE_MODEL_NAME = "gemini-3-flash-preview";
const GENERAL_MODEL_NAME = "gemini-3-flash-preview";

const logger = createLogger(config.logLevel, config.fileLog);
logger.info("Starting GenieAI bot...");

// Database
const db = createDb(config.databaseUrl);
const messageRepository = new PgMessageRepository(
    db,
    logger.child({ module: "repository" }),
);
const geminiApiKeyRepository = new PgGeminiApiKeyRepository(
    db,
    logger.child({ module: "repository:apiKey" }),
);
const geminiFileRepository = new PgGeminiFileRepository(
    db,
    logger.child({ module: "repository:gemini" }),
);

// Sync API keys from env → DB to assign stable UUIDs (required before wiring providers)
const apiKeySyncService = new GeminiApiKeySyncService(
    geminiApiKeyRepository,
    logger.child({ module: "apiKeySync" }),
);
const { freeKeys, paidKey } = await apiKeySyncService.sync(
    config.googleFreeApiKeys,
    config.googlePaidApiKey,
);

// Attachment infrastructure
const attachmentDownloader = new FetchAttachmentDownloader(
    logger.child({ module: "attachments" }),
);
const diskDownloader = new FetchDiskAttachmentDownloader(
    logger.child({ module: "attachments:disk" }),
);

// Lazy uploader registry — one GenaiFileUploader per API key, constructed on first use
const uploaderRegistry = new GenaiFileUploaderRegistry(
    [...freeKeys, paidKey],
    logger.child({ module: "attachments:uploaderRegistry" }),
);

// LLM tools
const getWebsiteTool = createGetWebsiteTool(
    logger.child({ module: "tool:website" }),
);
const getVideoTranscriptionTool = createGetVideoTranscriptionTool(
    logger.child({ module: "tool:video" }),
);

// Lazy model providers — one ChatGoogle client per (provider, apiKey) pair
const freeKeyProvider = new RoundRobinFreeKeyProvider(freeKeys);
const triageProvider = new TriageModelProvider({
    modelName: TRIAGE_MODEL_NAME,
    triageThinkingLevel: config.triageThinkingLevel,
    includeLLMThoughts: config.includeLLMThoughts,
    getWebsiteTool,
    getVideoTranscriptionTool,
});
const generalProvider = new GeneralModelProvider({
    modelName: GENERAL_MODEL_NAME,
    includeLLMThoughts: config.includeLLMThoughts,
});
const searchProvider = new SearchModelProvider(paidKey.apiKey, {
    modelName: GENERAL_MODEL_NAME,
    includeLLMThoughts: config.includeLLMThoughts,
});

// Gemini file refresh service — used by the orchestrator per key attempt
const geminiFileRefreshService = new GeminiFileRefreshService(
    geminiFileRepository,
    uploaderRegistry,
    diskDownloader,
    logger.child({ module: "attachments:refresh" }),
    config,
);

// Orchestrator
const orchestrator = new AgentOrchestrator(
    triageProvider,
    generalProvider,
    searchProvider,
    freeKeyProvider,
    paidKey,
    getWebsiteTool,
    getVideoTranscriptionTool,
    logger.child({ module: "orchestrator" }),
    config,
    geminiFileRefreshService,
);

// The primary uploader for new uploads in HandleDiscordMention uses the current free key.
// The refresh service handles uploading for other keys internally during orchestration.
const primaryUploader = uploaderRegistry.get(freeKeyProvider.currentKey.id);

// Application use case
const handleDiscordMention = new HandleDiscordMention(
    messageRepository,
    orchestrator,
    attachmentDownloader,
    logger.child({ module: "handler" }),
    config,
    diskDownloader,
    primaryUploader,
    geminiFileRepository,
);

// Discord gateway
const statusUpdater = new StatusMessageUpdater(
    logger.child({ module: "statusUpdater" }),
);
const gateway = new DiscordGateway(
    config.discordToken,
    handleDiscordMention.handle.bind(handleDiscordMention),
    handleDiscordMention.saveBotResponse.bind(handleDiscordMention),
    logger.child({ module: "discord" }),
    statusUpdater,
);

// Graceful shutdown
process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await gateway.stop();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    await gateway.stop();
    process.exit(0);
});

await gateway.start();
