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
import { GeminiApiKeySyncService } from "./application/services/GeminiApiKeySyncService.ts";
import { GeminiFileRefreshService } from "./application/services/GeminiFileRefreshService.ts";
import { GetNextPageUseCase } from "./application/use-cases/GetNextPage.ts";
import { HandleDiscordMessageUseCase } from "./application/use-cases/HandleDiscordMessage.ts";
import { RetryDiscordMessageUseCase } from "./application/use-cases/RetryDiscordMessage.ts";
import { FetchAttachmentDownloader } from "./infrastructure/attachments/FetchAttachmentDownloader.ts";
import { FetchDiskAttachmentDownloader } from "./infrastructure/attachments/FetchDiskAttachmentDownloader.ts";
import { GenaiFileUploaderRegistry } from "./infrastructure/attachments/GenaiFileUploaderRegistry.ts";
import { config } from "./infrastructure/config/config.ts";
import { createDb } from "./infrastructure/db/connection.ts";
import { PgGetNextPageQuery } from "./infrastructure/db/queries/PgGetNextPageQuery.ts";
import { PgGeminiApiKeyRepository } from "./infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { PgGeminiFileRepository } from "./infrastructure/db/repositories/PgGeminiFileRepository.ts";
import { PgMessagePageRepository } from "./infrastructure/db/repositories/PgMessagePageRepository.ts";
import { PgMessageRepository } from "./infrastructure/db/repositories/PgMessageRepository.ts";
import { DiscordGateway } from "./infrastructure/discord/DiscordGateway.ts";
import { StatusMessageUpdater } from "./infrastructure/discord/StatusMessageUpdater.ts";
import { AgentOrchestrator, type ModelTimeouts } from "./infrastructure/llm/agents/geminiAgentOrchestrator.ts";
import { GeneralModelProvider } from "./infrastructure/llm/models/generalModel.ts";
import { SearchModelProvider } from "./infrastructure/llm/models/searchModel.ts";
import { TriageModelProvider } from "./infrastructure/llm/models/triageModel.ts";
import { RoundRobinFreeKeyProvider } from "./infrastructure/llm/RoundRobinFreeKeyProvider.ts";
import { createGetVideoCaptionsTool } from "./infrastructure/llm/tools/getVideoCaptionsTool.ts";
import { createGetWebsiteTool } from "./infrastructure/llm/tools/getWebsiteTool.ts";
import { createLogger } from "./infrastructure/logging/logger.ts";

// Primary model names — used for triage, general, and search
const TRIAGE_MODEL_NAME = "gemini-3.1-flash-lite-preview";
const GENERAL_MODEL_NAME = "gemini-3-flash-preview";
const SEARCH_MODEL_NAME = "gemini-3-flash-preview";

// Fallback model names — activated on 503 or timeout (NOT on 429, which uses key rotation)
const TRIAGE_FALLBACK_MODEL = "gemini-2.5-flash";
const GENERAL_FALLBACK_MODEL = "gemini-2.5-flash";
const SEARCH_FALLBACK_MODEL = "gemini-2.5-flash";

// Per-model timeouts in ms — passed as RunnableConfig.timeout, which LangChain converts to
// an AbortSignal that propagates all the way to the HTTP layer, cancelling the request.
const MODEL_TIMEOUTS: ModelTimeouts = {
    triageTimeoutMs: 60_000,
    generalTimeoutMs: 120_000,
    searchTimeoutMs: 120_000,
};

const logger = createLogger(config.logLevel, config.fileLog);
logger.info("Starting GenieAI bot...");

// Database
const db = createDb(config.databaseUrl);
const messageRepository = new PgMessageRepository(db, logger.child({ module: "repository" }));
const geminiApiKeyRepository = new PgGeminiApiKeyRepository(db, logger.child({ module: "repository:apiKey" }));
const geminiFileRepository = new PgGeminiFileRepository(db, logger.child({ module: "repository:gemini" }));

// Sync API keys from env → DB to assign stable UUIDs (required before wiring providers)
const apiKeySyncService = new GeminiApiKeySyncService(geminiApiKeyRepository, logger.child({ module: "apiKeySync" }));
const { freeKeys, paidKey } = await apiKeySyncService.sync(config.googleFreeApiKeys, config.googlePaidApiKey);

// Attachment infrastructure
const attachmentDownloader = new FetchAttachmentDownloader(logger.child({ module: "attachments" }));
const diskDownloader = new FetchDiskAttachmentDownloader(logger.child({ module: "attachments:disk" }));

// Lazy uploader registry — one GenaiFileUploader per API key, constructed on first use
const uploaderRegistry = new GenaiFileUploaderRegistry(
    [...freeKeys, paidKey],
    logger.child({ module: "attachments:uploaderRegistry" }),
);

// LLM tools
const getWebsiteTool = createGetWebsiteTool(logger.child({ module: "tool:website" }));
const getVideoCaptionsTool = await createGetVideoCaptionsTool(
    logger.child({ module: "tool:video" }),
    config.ytDlpHttpProxy,
    config.proxyRetries,
);

// Lazy model providers — one ChatGoogle client per (provider, apiKey) pair
const freeKeyProvider = new RoundRobinFreeKeyProvider(freeKeys);
const triageProvider = new TriageModelProvider({
    modelName: TRIAGE_MODEL_NAME,
    fallbackModelName: TRIAGE_FALLBACK_MODEL,
    triageThinkingLevel: config.triageThinkingLevel,
    includeLLMThoughts: config.includeLLMThoughts,
    getWebsiteTool,
    getVideoCaptionsTool,
});
const generalProvider = new GeneralModelProvider({
    modelName: GENERAL_MODEL_NAME,
    fallbackModelName: GENERAL_FALLBACK_MODEL,
    includeLLMThoughts: config.includeLLMThoughts,
});
const searchProvider = new SearchModelProvider(paidKey.apiKey, {
    modelName: SEARCH_MODEL_NAME,
    fallbackModelName: SEARCH_FALLBACK_MODEL,
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
const agentOrchestrator = new AgentOrchestrator(
    triageProvider,
    generalProvider,
    searchProvider,
    freeKeyProvider,
    paidKey,
    getWebsiteTool,
    getVideoCaptionsTool,
    logger.child({ module: "agent-orchestrator" }),
    config,
    geminiFileRefreshService,
    MODEL_TIMEOUTS,
);

// The primary uploader for new uploads in HandleDiscordMessage uses the current free key.
// The refresh service handles uploading for other keys internally during orchestration.
const primaryUploader = uploaderRegistry.get(freeKeyProvider.currentKey.id);

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
);

// Pagination
const messagePageRepository = new PgMessagePageRepository(db, logger.child({ module: "repository:message-pages" }));
const getNextPageQuery = new PgGetNextPageQuery(db);
const getNextPage = new GetNextPageUseCase(getNextPageQuery, logger.child({ module: "get-next-page-use-case" }));

// Retry orchestration use case
const retryDiscordMessageUseCase = new RetryDiscordMessageUseCase(
    messageRepository,
    agentOrchestrator,
    logger.child({ module: "discord-message-retry-use-case" }),
);

// Discord gateway
const statusUpdater = new StatusMessageUpdater(logger.child({ module: "statusUpdater" }));
const gateway = new DiscordGateway(
    config.discordToken,
    handleDiscordMessageUseCase,
    logger.child({ module: "discord" }),
    statusUpdater,
    messagePageRepository,
    getNextPage,
    retryDiscordMessageUseCase,
    messageRepository,
);

// Graceful shutdown
async function shutdown() {
    logger.info("Shutting down...");
    await gateway.stop();
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

await gateway.start();
