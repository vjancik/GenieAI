/**
 * Composition root: wires all dependencies together and starts the application.
 *
 * This is the only place where concrete implementations are constructed and
 * injected into abstractions. All other modules depend on interfaces.
 */
import { HandleDiscordMention } from "./application/HandleDiscordMention.ts";
import { FetchAttachmentDownloader } from "./infrastructure/attachments/FetchAttachmentDownloader.ts";
import { config } from "./infrastructure/config/config.ts";
import { createDb } from "./infrastructure/db/connection.ts";
import { PgMessageRepository } from "./infrastructure/db/repositories/PgMessageRepository.ts";
import { DiscordGateway } from "./infrastructure/discord/DiscordGateway.ts";
import { StatusMessageUpdater } from "./infrastructure/discord/StatusMessageUpdater.ts";
import { createGeneralModel } from "./infrastructure/llm/agents/generalAgent.ts";
import { createSearchModel } from "./infrastructure/llm/agents/searchAgent.ts";
import { createTriageModel } from "./infrastructure/llm/agents/triageAgent.ts";
import { Orchestrator } from "./infrastructure/llm/orchestrator.ts";
import { createGetVideoTranscriptionTool } from "./infrastructure/llm/tools/getVideoTranscriptionTool.ts";
import { createGetWebsiteTool } from "./infrastructure/llm/tools/getWebsiteTool.ts";
import { createLogger } from "./infrastructure/logging/logger.ts";

const logger = createLogger(config.logLevel);
logger.info("Starting GenieAI bot...");

// Database
const db = createDb(config.databaseUrl);
const messageRepository = new PgMessageRepository(
    db,
    logger.child({ module: "repository" }),
);

// LLM tools
const getWebsiteTool = createGetWebsiteTool(
    logger.child({ module: "tool:website" }),
);
const getVideoTranscriptionTool = createGetVideoTranscriptionTool(
    logger.child({ module: "tool:video" }),
);

// LLM models
const triageModel = createTriageModel({
    config,
    getWebsiteTool,
    getVideoTranscriptionTool,
});
const generalModel = createGeneralModel(config);
const searchModel = createSearchModel(config);

// Orchestrator
const orchestrator = new Orchestrator(
    triageModel,
    generalModel,
    searchModel,
    getWebsiteTool,
    getVideoTranscriptionTool,
    logger.child({ module: "orchestrator" }),
    config,
);

// Attachment downloader
const attachmentDownloader = new FetchAttachmentDownloader(
    logger.child({ module: "attachments" }),
);

// Application use case
const handleDiscordMention = new HandleDiscordMention(
    messageRepository,
    orchestrator,
    attachmentDownloader,
    logger.child({ module: "handler" }),
    config,
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
