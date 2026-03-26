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
import { sanitizeForLog } from "./application/helpers/errorHelpers.ts";
import { AgentMessageBuilder } from "./application/services/AgentMessageBuilder.ts";
import { GeminiApiKeySyncService } from "./application/services/GeminiApiKeySync.ts";
import { GeminiMediaNormalizer } from "./application/services/GeminiMediaNormalizer.ts";
import { InlineMediaNormalizer } from "./application/services/InlineMediaNormalizer.ts";
import { StatusMessageUpdater } from "./application/services/StatusMessageUpdater.ts";
import { HandleChatMessageUseCase } from "./application/use-cases/HandleChatMessage.ts";
import { HandleExportUseCase } from "./application/use-cases/HandleMessageExport.ts";
import { HandleNextPageUseCase } from "./application/use-cases/HandleMessageNextPage.ts";
import { HandleRetryUseCase } from "./application/use-cases/HandleMessageRetry.ts";
import { HandleSummarizeUseCase } from "./application/use-cases/HandleMessageSummarize.ts";
import { FetchAttachmentDownloader } from "./infrastructure/attachments/FetchAttachmentDownloader.ts";
import { FetchStreamingAttachmentDownloader } from "./infrastructure/attachments/FetchStreamingAttachmentDownloader.ts";
import { GenaiFileUploaderRegistry } from "./infrastructure/attachments/GenaiFileUploaderRegistry.ts";
import { createDb } from "./infrastructure/db/connection.ts";
import { PgGetNextPageQuery } from "./infrastructure/db/queries/PgGetNextPageQuery.ts";
import { PgGeminiApiKeyRepository } from "./infrastructure/db/repositories/PgGeminiApiKeyRepository.ts";
import { PgGeminiFileRepository } from "./infrastructure/db/repositories/PgGeminiFileRepository.ts";
import { PgMessagePageRepository } from "./infrastructure/db/repositories/PgMessagePageRepository.ts";
import { PgMessageRepository } from "./infrastructure/db/repositories/PgMessageRepository.ts";
import { DiscordClientBot } from "./infrastructure/discord/adapters/DiscordClientBot.ts";
import { DiscordChatMessageService } from "./infrastructure/discord/DiscordChatMessageService.ts";
import { DiscordClient } from "./infrastructure/discord/DiscordClient.ts";
import { DiscordCommandRegistry } from "./infrastructure/discord/DiscordCommandRegistry.ts";
import { DiscordGateway } from "./infrastructure/discord/DiscordGateway.ts";
import { DiscordMediaService } from "./infrastructure/discord/DiscordMediaService.ts";
import { InteractionLock } from "./infrastructure/discord/InteractionLock.ts";
import { RateLimiter } from "./infrastructure/discord/RateLimiter.ts";
import { HtmlToImageRenderer } from "./infrastructure/exporters/HtmlToImageRenderer.ts";
import { MarkdownToHtmlRenderer } from "./infrastructure/exporters/MarkdownToHtmlRenderer.ts";
import { AgentOrchestrator } from "./infrastructure/llm/agents/agentOrchestrator.ts";
import { GeneralModelProvider } from "./infrastructure/llm/models/generalModel.ts";
import { SearchModelProvider } from "./infrastructure/llm/models/searchModel.ts";
import { TavilyOnlyTriageModelProvider, TriageModelProvider } from "./infrastructure/llm/models/triageModel.ts";
import { ResilientModelInvoker } from "./infrastructure/llm/ResilientModelInvoker.ts";
import { RoundRobinFreeKeyProvider } from "./infrastructure/llm/RoundRobinFreeKeyProvider.ts";
import { SinglePaidKeyProvider } from "./infrastructure/llm/SinglePaidKeyProvider.ts";
import { createGetVideoCaptionsTool } from "./infrastructure/llm/tools/getVideoCaptionsTool.ts";
import { createGetWebsiteTool } from "./infrastructure/llm/tools/getWebsiteTool.ts";
import { createTavilyTool } from "./infrastructure/llm/tools/tavilySearchTool.ts";
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
const streamingDownloader = new FetchStreamingAttachmentDownloader(
    logger.child({ module: "attachments:streaming" }),
    config,
);

// Lazy uploader registry — one GenaiFileUploader per API key, constructed on first use
const uploaderRegistry = new GenaiFileUploaderRegistry(
    [...freeKeys, ...(paidKey !== null ? [paidKey] : [])],
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
const tavilyTool = config.file.agent.nodes.search.mode === "tavily" ? createTavilyTool() : undefined;

// Lazy model providers — one ChatGoogle client per (provider, apiKey) pair
const freeKeyProvider = new RoundRobinFreeKeyProvider(freeKeys, geminiApiKeyRepository);
// TYPE COERCION: validateConfig throws before this point if any node uses apiKeyType "paid" without GOOGLE_PAID_API_KEY set
// biome-ignore lint/style/noNonNullAssertion: guaranteed non-null by validateConfig above
const paidKeyProvider = new SinglePaidKeyProvider(paidKey!);
const triageProvider = new TriageModelProvider({
    modelName: config.file.agent.nodes.triage.model,
    fallbackModelName: config.file.agent.nodes.triage.fallbackModel,
    thinkingLevel: config.file.agent.nodes.triage.thinkingLevel,
    includeThoughts: config.file.geminiModels.includeThoughts,
    searchMode: config.file.agent.nodes.search.mode,
    getWebsiteTool,
    getVideoCaptionsTool,
    tavilyTool,
});
const tavilyOnlyTriageProvider = tavilyTool
    ? new TavilyOnlyTriageModelProvider({
          modelName: config.file.agent.nodes.triage.model,
          fallbackModelName: config.file.agent.nodes.triage.fallbackModel,
          thinkingLevel: config.file.agent.nodes.triage.thinkingLevel,
          includeThoughts: config.file.geminiModels.includeThoughts,
          tavilyTool,
      })
    : undefined;
const generalProvider = new GeneralModelProvider({
    modelName: config.file.agent.nodes.general.model,
    fallbackModelName: config.file.agent.nodes.general.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
});
const searchProvider = new SearchModelProvider({
    modelName: config.file.agent.nodes.search.model,
    fallbackModelName: config.file.agent.nodes.search.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
    searchMode: config.file.agent.nodes.search.mode,
});

// Discord client lifecycle wrapper — created before use cases and gateway so both can share it
const discordClient = new DiscordClient(config.discordToken, logger.child({ module: "discord-client" }));
const commandRegistry = new DiscordCommandRegistry(
    discordClient,
    config.discordClientId,
    logger.child({ module: "discord-commands" }),
);

const discordMediaService = new DiscordMediaService(discordClient);

const inlineMediaNormalizer = new InlineMediaNormalizer(
    discordMediaService,
    attachmentDownloader,
    logger.child({ module: "attachments:inline-normalizer" }),
);

const geminiMediaNormalizer = new GeminiMediaNormalizer(
    geminiFileRepository,
    messageRepository,
    uploaderRegistry,
    streamingDownloader,
    discordMediaService,
    logger.child({ module: "attachments:gemini-normalizer" }),
    config,
);

const isInlineMode = config.file.agent.uploadAttachmentMode === "inline";

// Resilient invoker — owns key rotation, Gemini file normalization, attachment filtering, and fallback policy
const resilientInvoker = new ResilientModelInvoker(
    freeKeyProvider,
    paidKeyProvider,
    config.file.agent.uploadAttachmentMode,
    config.file.agent.maxInlineAttachmentSizeBytes,
    config.file.globalModelTimeoutMs,
    logger.child({ module: "llm:resilient-invoker" }),
    isInlineMode ? undefined : geminiMediaNormalizer,
);

// Orchestrator
const agentOrchestrator = new AgentOrchestrator(
    triageProvider,
    generalProvider,
    searchProvider,
    resilientInvoker,
    getWebsiteTool,
    getVideoCaptionsTool,
    logger.child({ module: "agent-orchestrator" }),
    config,
    tavilyTool,
    tavilyOnlyTriageProvider,
);

// Live Discord chain fetch service — used as fallback when DB reply chain is empty
const discordChatMessageService = new DiscordChatMessageService(
    discordClient,
    logger.child({ module: "discord-chat" }),
    config.file,
);

// Pagination
const messagePageRepository = new PgMessagePageRepository(db, logger.child({ module: "repository:message-pages" }));
const getNextPageQuery = new PgGetNextPageQuery(db);

// Exporters — singletons shared across all export command invocations
const markdownToHtml = new MarkdownToHtmlRenderer();
const htmlToImage = new HtmlToImageRenderer();

// Discord gateway
const statusUpdater = new StatusMessageUpdater(logger.child({ module: "statusUpdater" }));
const discordClientBot = new DiscordClientBot(discordClient.client);
// TODO: change to module of functions
const agentMessageBuilder = new AgentMessageBuilder(logger.child({ module: "agent-message-builder" }));
const handleChatMessageUseCase = new HandleChatMessageUseCase(
    agentOrchestrator,
    messageRepository,
    statusUpdater,
    logger.child({ module: "handle-chat-message-use-case" }),
    discordClientBot,
    config.file.discord.previousBotId,
    messagePageRepository,
    config.file.discord.retries,
    config.file.agent.nodes.search.mode,
    agentMessageBuilder,
    discordChatMessageService,
    config.file.discord.enableInDMs,
    isInlineMode ? inlineMediaNormalizer : undefined,
    isInlineMode ? config.file.agent.maxInlineAttachmentSizeBytes : null,
);

// Shared interaction lock — one instance reused across all use cases that need locking
const interactionLock = new InteractionLock();

const handleNextPageUseCase = new HandleNextPageUseCase(
    getNextPageQuery,
    messageRepository,
    messagePageRepository,
    discordClientBot,
    logger.child({ module: "next-page" }),
    interactionLock,
);
const handleRetryUseCase = new HandleRetryUseCase(
    handleChatMessageUseCase,
    messageRepository,
    discordClientBot,
    logger.child({ module: "retry" }),
    interactionLock,
);
const handleSummarizeUseCase = new HandleSummarizeUseCase(
    handleChatMessageUseCase,
    messageRepository,
    discordClientBot,
    logger.child({ module: "summarize" }),
    config.file.discord.enableInDMs,
);
const handleExportUseCase = new HandleExportUseCase(
    messageRepository,
    markdownToHtml,
    htmlToImage,
    discordClientBot,
    logger.child({ module: "export" }),
    config.file.discord.previousBotId,
    interactionLock,
);

const rateLimiter = new RateLimiter([
    { windowMs: 3_000, limit: 3 },
    { windowMs: 60_000, limit: 10 },
]);
const discordGateway = new DiscordGateway(
    discordClient,
    handleChatMessageUseCase,
    logger.child({ module: "discord" }),
    handleNextPageUseCase,
    handleRetryUseCase,
    handleSummarizeUseCase,
    handleExportUseCase,
    rateLimiter,
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
    sanitizeForLog(reason);
    Sentry.captureException(reason);
    logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
    sanitizeForLog(error);
    Sentry.captureException(error);
    logger.error({ error }, "Uncaught exception");
    process.exit(1);
});

void commandRegistry.register().catch(() => {});
await discordClient.start();
