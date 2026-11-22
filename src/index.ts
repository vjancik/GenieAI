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
import { DiscordMediaSource } from "./application/services/DiscordMediaSource.ts";
import { GeminiApiKeySyncService } from "./application/services/GeminiApiKeySync.ts";
import { GeminiMediaNormalizer } from "./application/services/GeminiMediaNormalizer.ts";
import { InlineMediaNormalizer } from "./application/services/InlineMediaNormalizer.ts";
import { RoutingMediaSource } from "./application/services/RoutingMediaSource.ts";
import { StatusMessageUpdater } from "./application/services/StatusMessageUpdater.ts";
import { HandleChatMessageUseCase } from "./application/use-cases/HandleChatMessage.ts";
import { HandleExportUseCase } from "./application/use-cases/HandleMessageExport.ts";
import { HandleNextPageUseCase } from "./application/use-cases/HandleMessageNextPage.ts";
import { HandleRetryUseCase } from "./application/use-cases/HandleMessageRetry.ts";
import { HandleSourcesUseCase } from "./application/use-cases/HandleMessageSources.ts";
import { HandleSummarizeUseCase } from "./application/use-cases/HandleMessageSummarize.ts";
import { FetchAttachmentDownloader } from "./infrastructure/attachments/FetchAttachmentDownloader.ts";
import { FetchStreamingAttachmentDownloader } from "./infrastructure/attachments/FetchStreamingAttachmentDownloader.ts";
import { GenaiFileUploaderRegistry } from "./infrastructure/attachments/GenaiFileUploaderRegistry.ts";
import { ImpitExternalFileSource } from "./infrastructure/attachments/ImpitExternalFileSource.ts";
import { BrowserPageFetcher } from "./infrastructure/browser/BrowserPageFetcher.ts";
import { ChromiumProvider } from "./infrastructure/browser/ChromiumProvider.ts";
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
import { createImpitClient } from "./infrastructure/http/impitClient.ts";
import { AgentOrchestrator } from "./infrastructure/llm/agents/agentOrchestrator.ts";
import { ComputationModelProvider } from "./infrastructure/llm/models/computationModel.ts";
import { GeneralModelProvider } from "./infrastructure/llm/models/generalModel.ts";
import { GoogleSearchModelProvider } from "./infrastructure/llm/models/googleSearchModel.ts";
import {
    buildSearchIntentTriageTools,
    buildTriageTools,
    TriageModelProvider,
} from "./infrastructure/llm/models/triageModel.ts";
import { ResilientModelInvoker } from "./infrastructure/llm/ResilientModelInvoker.ts";
import { RoundRobinKeyProvider } from "./infrastructure/llm/RoundRobinKeyProvider.ts";
import { createGetVideoCaptionsTool } from "./infrastructure/llm/tools/getVideoCaptionsTool.ts";
import { createGetWebsiteTool } from "./infrastructure/llm/tools/getWebsiteTool.ts";
import { createTavilyTool } from "./infrastructure/llm/tools/tavilySearchTool.ts";
import { createLogger } from "./infrastructure/logging/logger.ts";

const logger = createLogger(
    process.env.LOG_LEVEL?.toLowerCase() ?? "info",
    process.env.FILE_LOG?.toLowerCase() === "true",
);

logger.info("Starting GenieAI bot...");

// Gemini wire tap (disabled): records raw Gemini traffic to logs/geminiWireTap for diagnosing
// streams that end without a finish reason. To re-enable, import `installGeminiWireTap` from
// ./infrastructure/llm/debug/GeminiWireTap.ts and `path` from node:path, then call:
//   installGeminiWireTap(path.resolve(import.meta.dir, "../logs/geminiWireTap"), logger.child({ module: "debug:gemini-wire-tap" }));

const configProvider = new ConfigProvider(logger);
const config = await configProvider.get();

// Database
const db = createDb(config.databaseUrl);
const messageRepository = new PgMessageRepository(db, logger.child({ module: "repository:messages" }));
const geminiApiKeyRepository = new PgGeminiApiKeyRepository(db, logger.child({ module: "repository:gemini-api-keys" }));
const geminiFileRepository = new PgGeminiFileRepository(db, logger.child({ module: "repository:gemini-files" }));

// Sync API keys from env → DB to assign stable UUIDs (required before wiring providers)
const apiKeySyncService = new GeminiApiKeySyncService(
    geminiApiKeyRepository,
    logger.child({ module: "service:api-key-sync" }),
);
const { freeKeys, paidKeys } = await apiKeySyncService.sync(config.googleFreeApiKeys, config.googlePaidApiKeys);

// Attachment infrastructure
const attachmentDownloader = new FetchAttachmentDownloader(
    logger.child({ module: "attachments:memory-downloader" }),
    config,
);
const streamingDownloader = new FetchStreamingAttachmentDownloader(
    logger.child({ module: "attachments:streaming-downloader" }),
    config,
);

// Lazy uploader registry — one GenaiFileUploader per API key, constructed on first use
const uploaderRegistry = new GenaiFileUploaderRegistry(
    [...freeKeys, ...paidKeys],
    logger.child({ module: "attachments:uploader-registry" }),
    config.file,
);

// Shared Chromium — one browser for both image rendering and browser-backed web fetches
const chromiumProvider = new ChromiumProvider(logger.child({ module: "browser" }));

// LLM tools
// Files found at a URL can only be loaded into the conversation in upload mode
const isInlineMode = config.file.agent.uploadAttachmentMode === "inline";
const getWebsiteTool = createGetWebsiteTool(
    logger.child({ module: "tool:website" }),
    new BrowserPageFetcher(chromiumProvider, logger.child({ module: "browser:fetch" })),
    isInlineMode ? undefined : { maxBytes: config.file.agent.maxExternalUrlFileSizeBytes },
);
const getVideoCaptionsTool = await createGetVideoCaptionsTool(
    logger.child({ module: "tool:video" }),
    config.file.ytDlp,
);
const tavilyTool =
    config.file.agent.searchMode === "tavily" ? createTavilyTool(logger.child({ module: "tool:search" })) : undefined;

// Lazy model providers — one ChatGoogle client per (provider, apiKey) pair
// Key pools — validateConfig has already ensured that every pool an agent node uses is non-empty.
// Only the free pool resumes its rotation cursor across restarts (the DB can track a single
// cursor); the paid pool always starts from the first key, respecting the configured order.
const freeKeyProvider = new RoundRobinKeyProvider(freeKeys, geminiApiKeyRepository);
const paidKeyProvider = new RoundRobinKeyProvider(paidKeys);
const triageModelSettings = {
    modelName: config.file.agent.nodes.triage.model,
    fallbackModelName: config.file.agent.nodes.triage.fallbackModel,
    thinkingLevel: config.file.agent.nodes.triage.thinkingLevel,
    includeThoughts: config.file.geminiModels.includeThoughts,
};
const triageProvider = new TriageModelProvider({
    ...triageModelSettings,
    tools: buildTriageTools({
        searchMode: config.file.agent.searchMode,
        getWebsiteTool,
        getVideoCaptionsTool,
        tavilyTool,
    }),
});
// Tavily mode only: triage for a declared SEARCH intent mainly writes the search query
const searchIntentTriageProvider = tavilyTool
    ? new TriageModelProvider({
          ...triageModelSettings,
          tools: buildSearchIntentTriageTools({ getWebsiteTool, getVideoCaptionsTool, tavilyTool }),
      })
    : undefined;
const generalProvider = new GeneralModelProvider({
    modelName: config.file.agent.nodes.general.model,
    fallbackModelName: config.file.agent.nodes.general.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
});
const computationProvider = new ComputationModelProvider({
    modelName: config.file.agent.nodes.computation.model,
    fallbackModelName: config.file.agent.nodes.computation.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
});
// Only invoked in Google search mode; in Tavily mode the general model answers from search results
const googleSearchProvider = new GoogleSearchModelProvider({
    modelName: config.file.agent.nodes.googleSearch.model,
    fallbackModelName: config.file.agent.nodes.googleSearch.fallbackModel,
    includeThoughts: config.file.geminiModels.includeThoughts,
});

// Discord client lifecycle wrapper — created before use cases and gateway so both can share it
const discordClient = new DiscordClient(config.discordToken, logger.child({ module: "discord:client" }));
const commandRegistry = new DiscordCommandRegistry(
    discordClient,
    config.discordClientId,
    logger.child({ module: "discord:commands" }),
);

const discordMediaService = new DiscordMediaService(discordClient);

const inlineMediaNormalizer = new InlineMediaNormalizer(
    discordMediaService,
    attachmentDownloader,
    logger.child({ module: "attachments:inline-normalizer" }),
);

// Opens the media behind a token URL, wherever it lives: on Discord or on the web
const mediaSource = new RoutingMediaSource(
    new DiscordMediaSource(
        discordMediaService,
        streamingDownloader,
        logger.child({ module: "attachments:discord-source" }),
    ),
    new ImpitExternalFileSource(
        // No request deadline: a download takes as long as its size demands
        (browser) => createImpitClient(browser, null),
        logger.child({ module: "attachments:external-source" }),
        {
            maxBytes: config.file.agent.maxExternalUrlFileSizeBytes,
            responseTimeoutMs: config.file.attachmentDownloader.timeoutMs,
        },
    ),
    logger.child({ module: "attachments:media-source" }),
);

const geminiMediaNormalizer = new GeminiMediaNormalizer(
    geminiFileRepository,
    messageRepository,
    uploaderRegistry,
    mediaSource,
    logger.child({ module: "attachments:gemini-normalizer" }),
    config,
);

// Resilient invoker — owns key rotation, Gemini file normalization, attachment filtering, and fallback policy
const resilientInvoker = new ResilientModelInvoker(
    freeKeyProvider,
    paidKeyProvider,
    {
        attachmentMode: config.file.agent.uploadAttachmentMode,
        maxInlineBytes: config.file.agent.maxInlineAttachmentSizeBytes,
        globalTimeoutMs: config.file.globalModelTimeoutMs,
        fallbackExecutionMode: config.file.agent.fallbackExecutionMode,
    },
    logger.child({ module: "llm:resilient-invoker" }),
    isInlineMode ? undefined : geminiMediaNormalizer,
);

// Orchestrator
const agentOrchestrator = new AgentOrchestrator(
    triageProvider,
    generalProvider,
    computationProvider,
    googleSearchProvider,
    resilientInvoker,
    getWebsiteTool,
    getVideoCaptionsTool,
    logger.child({ module: "agent" }),
    config,
    tavilyTool,
    searchIntentTriageProvider,
);

// Live Discord chain fetch service — used as fallback when DB reply chain is empty
const discordChatMessageService = new DiscordChatMessageService(
    discordClient,
    logger.child({ module: "service:discord-messages" }),
    config.file,
);

// Pagination
const messagePageRepository = new PgMessagePageRepository(db, logger.child({ module: "repository:message-pages" }));
const getNextPageQuery = new PgGetNextPageQuery(db);

// Exporters — singletons shared across all export command invocations
const markdownToHtml = new MarkdownToHtmlRenderer();
const htmlToImage = new HtmlToImageRenderer(chromiumProvider);

// Discord gateway
const statusUpdater = new StatusMessageUpdater(logger.child({ module: "statusUpdater" }));
const discordClientBot = new DiscordClientBot(discordClient.client);
const handleChatMessageUseCase = new HandleChatMessageUseCase(
    agentOrchestrator,
    messageRepository,
    statusUpdater,
    logger.child({ module: "use-case:handle-chat-message" }),
    discordClientBot,
    config.file.discord.previousBotId,
    messagePageRepository,
    config.file.discord.retries,
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
    logger.child({ module: "use-case:next-page" }),
    interactionLock,
);
const handleRetryUseCase = new HandleRetryUseCase(
    handleChatMessageUseCase,
    messageRepository,
    logger.child({ module: "use-case:retry" }),
    interactionLock,
);
const handleSourcesUseCase = new HandleSourcesUseCase(
    messageRepository,
    config.file.agent.searchMode,
    logger.child({ module: "use-case:sources" }),
);
const handleSummarizeUseCase = new HandleSummarizeUseCase(
    handleChatMessageUseCase,
    messageRepository,
    discordClientBot,
    logger.child({ module: "use-case:summarize" }),
    config.file.discord.enableInDMs,
);
const handleExportUseCase = new HandleExportUseCase(
    messageRepository,
    messagePageRepository,
    markdownToHtml,
    htmlToImage,
    discordClientBot,
    logger.child({ module: "use-case:export" }),
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
    logger.child({ module: "discord:gateway" }),
    handleNextPageUseCase,
    handleRetryUseCase,
    handleSummarizeUseCase,
    handleExportUseCase,
    handleSourcesUseCase,
    rateLimiter,
);

// Graceful shutdown
async function shutdown() {
    logger.info("Shutting down...");
    await discordGateway.gracefulShutdown();
    discordClient.stop();
    // Release the render context before closing the browser that owns it
    await htmlToImage.shutdown();
    await chromiumProvider.shutdown();
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
