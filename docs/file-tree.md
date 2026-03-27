# File Tree

_Generated 2026-03-27 at commit `db4af85`_

NOTE: Non-exhaustive descriptions.

```
GenieAIV2/
├── src/
│   ├── index.ts                                        # DI composition root — wires all dependencies and starts the bot
│   │
│   ├── domain/                                         # Core business concepts with no external dependencies
│   │   ├── entities/
│   │   │   ├── Message.ts                              # Persisted chat message entity (human or bot)
│   │   │   ├── GeminiApiKey.ts                         # Gemini API key entity with free/paid tier distinction
│   │   │   ├── GeminiFile.ts                           # Uploaded Gemini file anchor (maps discord:// URL → Gemini URI)
│   │   │   ├── GeminiFileUpload.ts                     # Value type for an in-progress Gemini file upload
│   │   │   └── MessagePage.ts                          # Pending pagination page state entity
│   │   ├── errors/
│   │   │   └── AppError.ts                             # Base custom error class for typed application errors
│   │   ├── ports/
│   │   │   ├── IGeminiApiKeyRepository.ts              # Repository port for Gemini API key CRUD
│   │   │   ├── IGeminiFileRepository.ts                # Repository port for Gemini file anchor CRUD
│   │   │   ├── IMessagePageRepository.ts               # Repository port for pagination page state
│   │   │   └── IMessageRepository.ts                   # Repository port for chat message persistence
│   │   └── value-objects/
│   │       └── MessageIntent.ts                        # Enum of recognized user intents (!ai, !aisearch, !aisummary, unknown)
│   │
│   ├── application/                                    # Orchestration and use-case logic; depends on domain only
│   │   ├── config/
│   │   │   └── AppConfig.ts                            # Config schema, validation, defaults (Zod)
│   │   ├── formatters/
│   │   │   ├── agentStatus.ts                          # Builds the live status message shown during processing
│   │   │   ├── groundingSources.ts                     # Formats web search sources as a Discord footer line
│   │   │   ├── markdownSplitter.ts                     # Splits long markdown into ≤2000-char Discord pages
│   │   │   └── textTransformers.ts                     # Converts LLM output to Discord-safe markdown
│   │   ├── helpers/
│   │   │   ├── buildLangchainMessage.ts                # Converts a persisted Message entity to a LangChain BaseMessage
│   │   │   ├── errorHelpers.ts                         # Shared error classification utilities
│   │   │   ├── extractUserContent.ts                   # Strips bot mentions and command prefixes from raw message text
│   │   │   ├── hasExtendedMarkdown.ts                  # Detects math equations or tables warranting the Render button
│   │   │   ├── messageTransformers.ts                  # Maps application-layer message DTOs
│   │   │   └── parseMessageIntent.ts                   # Parses command prefix from message content to derive intent
│   │   ├── ports/
│   │   │   ├── chat/
│   │   │   │   ├── IChatClient.ts                      # Top-level port: receives Discord events and dispatches use cases
│   │   │   │   ├── IChatClientBot.ts                   # Port: bot user identity (ID, username)
│   │   │   │   ├── IChatClientButtonInteraction.ts     # Port: button click interaction
│   │   │   │   ├── IChatClientChannel.ts               # Port: channel send / permission checks
│   │   │   │   ├── IChatClientContextMenuInteraction.ts # Port: right-click context menu interaction
│   │   │   │   ├── IChatClientMessage.ts               # Port: incoming chat message (content, attachments, reply chain)
│   │   │   │   └── IChatClientMessageMedia.ts          # Port: a single media attachment on a message
│   │   │   ├── IAgentOrchestrator.ts                   # Port: runs triage + tool + generation pipeline
│   │   │   ├── IAttachmentDownloader.ts                # Port: downloads an attachment into memory
│   │   │   ├── IChatMessageService.ts                  # Port: sends and edits Discord messages
│   │   │   ├── IDiscordMediaService.ts                 # Port: resolves discord:// token URLs to raw bytes/URI
│   │   │   ├── IDiskAttachmentDownloader.ts            # Port: streams an attachment to disk
│   │   │   ├── IGeminiFileUploaderRegistry.ts          # Port: upload-mode file cache (find-or-upload by token URL)
│   │   │   ├── IGeminiFileUploader.ts                  # Port: uploads a file to the Gemini Files API
│   │   │   ├── IGeminiMediaNormalizer.ts               # Port: resolves media token blocks for Gemini upload mode
│   │   │   ├── IGetNextPageQuery.ts                    # Port: fetches a stored pagination page from the DB
│   │   │   ├── IImageRenderer.ts                       # Port: renders markdown to a PNG image
│   │   │   ├── IInlineMediaNormalizer.ts               # Port: resolves media token blocks for inline (base64) mode
│   │   │   ├── IInteractionLock.ts                     # Port: per-message mutex preventing duplicate interactions
│   │   │   ├── IMarkdownRenderer.ts                    # Port: renders markdown to HTML
│   │   │   ├── IModelProvider.ts                       # Port: returns the configured LangChain model for a given node
│   │   │   ├── IModelTool.ts                           # Port: a tool the LLM can invoke
│   │   │   ├── IResilientModelInvoker.ts               # Port: invokes a model with fallback + timeout logic
│   │   │   ├── IRoundRobinKeyProvider.ts               # Port: yields the next API key in rotation
│   │   │   └── IStreamingAttachmentDownloader.ts       # Port: streams an attachment chunk-by-chunk
│   │   ├── services/
│   │   │   ├── GeminiApiKeySync.ts                     # Syncs API keys from config into the DB on startup
│   │   │   ├── GeminiMediaNormalizer.ts                # Upload-mode: resolves discord:// tokens → Gemini fileUri blocks
│   │   │   ├── InlineMediaNormalizer.ts                # Inline-mode: resolves discord:// tokens → base64 data blocks
│   │   │   └── StatusMessageUpdater.ts                 # Manages the live "thinking…" status message lifecycle
│   │   ├── types/
│   │   │   ├── AgentStatus.ts                          # Enum of status phases shown during processing
│   │   │   ├── Logger.ts                               # Logger interface type (TODO: ILogger)
│   │   │   └── ThinkingLevel.ts                        # Enum of triage thinking budget levels
│   │   └── use-cases/
│   │       ├── HandleChatMessage.ts                    # Main use case: processes an incoming @mention or command
│   │       ├── HandleMessageExport.ts                  # Use case: exports a bot message as HTML or PNG
│   │       ├── HandleMessageNextPage.ts                # Use case: delivers the next pagination page on button click
│   │       ├── HandleMessageRetry.ts                   # Use case: retries a failed or fallback response
│   │       └── HandleMessageSummarize.ts               # Use case: summarizes a message via context menu
│   │
│   └── infrastructure/                                 # Concrete adapters; depends on application ports
│       ├── attachments/
│       │   ├── contentBlockMapper.ts                   # Maps downloaded attachment bytes to LangChain content blocks
│       │   ├── FetchAttachmentDownloader.ts            # Downloads attachments into memory via fetch
│       │   ├── FetchStreamingAttachmentDownloader.ts   # Streams attachments to disk via fetch
│       │   ├── GenaiFileUploader.ts                    # Uploads a file to Gemini Files API and polls until ready
│       │   ├── GenaiFileUploaderRegistry.ts            # Caches upload results per discord:// token URL; deduplicates concurrent uploads
│       │   └── GoogleGenAI.ts                          # Thin wrapper around the Google GenAI SDK client
│       ├── db/
│       │   ├── connection.ts                           # Creates a Drizzle ORM client (Bun native SQL)
│       │   ├── pgTextArray.ts                          # Drizzle custom type for PostgreSQL text[]
│       │   ├── schema.ts                               # Full Drizzle schema definition for all tables
│       │   ├── queries/
│       │   │   └── PgGetNextPageQuery.ts               # Fetches a stored page row and deletes it atomically
│       │   └── repositories/
│       │       ├── PgGeminiApiKeyRepository.ts         # Gemini API key persistence (PostgreSQL)
│       │       ├── PgGeminiFileRepository.ts           # Gemini file anchor persistence (PostgreSQL)
│       │       ├── PgMessagePageRepository.ts          # Pagination page state persistence (PostgreSQL)
│       │       └── PgMessageRepository.ts             # Chat message persistence with recursive reply-chain CTE
│       ├── discord/
│       │   ├── adapters/
│       │   │   ├── DiscordClientBot.ts                 # Adapter: bot user identity from discord.js client
│       │   │   ├── DiscordClientButtonInteraction.ts   # Adapter: wraps a discord.js ButtonInteraction
│       │   │   ├── DiscordClientChannel.ts             # Adapter: wraps a discord.js TextChannel
│       │   │   ├── DiscordClientContextMenuInteraction.ts # Adapter: wraps a discord.js ContextMenuInteraction
│       │   │   ├── DiscordClientMessage.ts             # Adapter: wraps a discord.js Message
│       │   │   └── DiscordClientMessageMedia.ts        # Adapter: wraps a discord.js Attachment or embed media
│       │   ├── DiscordChatMessageService.ts            # Sends, edits, and deletes Discord messages
│       │   ├── DiscordClient.ts                        # Initializes the discord.js client with required intents
│       │   ├── DiscordCommandRegistry.ts               # Registers slash commands and context menu entries with Discord
│       │   ├── DiscordGateway.ts                       # Entry point: routes Discord events to use cases
│       │   ├── DiscordMediaService.ts                  # Resolves discord:// token URLs to raw bytes or Discord CDN URLs
│       │   ├── discordTokenUrl.ts                      # Parse/build helpers for internal discord:// token URLs
│       │   ├── InteractionLock.ts                      # In-memory per-message mutex
│       │   └── RateLimiter.ts                          # Sliding-window per-user rate limiter (burst + sustained)
│       ├── exporters/
│       │   ├── HtmlToImageRenderer.ts                  # Renders HTML to PNG via Puppeteer
│       │   └── MarkdownToHtmlRenderer.ts               # Renders markdown (+ math + tables) to HTML
│       ├── http/
│       │   └── redirectUrl.ts                          # Follows HTTP redirects to resolve a final URL
│       ├── instrumentation/sentry/
│       │   └── instrumentation.ts                      # Sentry error and tracing setup
│       ├── llm/
│       │   ├── agents/
│       │   │   └── agentOrchestrator.ts                # Single-pass triage → tool dispatch → generation pipeline
│       │   ├── errors/
│       │   │   ├── is429Error.ts                       # Detects HTTP 429 (rate limit) errors
│       │   │   ├── is503Error.ts                       # Detects HTTP 503 (service unavailable) errors
│       │   │   ├── isModelFallbackError.ts             # Detects errors that should trigger fallback model use
│       │   │   └── isTimeoutError.ts                   # Detects invocation timeout errors
│       │   ├── models/
│       │   │   ├── basePrompt.ts                       # Shared system prompt injected into all models
│       │   │   ├── generalModel.ts                     # Builds the ChatGoogle model for general queries
│       │   │   ├── searchModel.ts                      # Builds the ChatGoogle model with web search grounding
│       │   │   ├── sharedGeminiSettings.ts             # Common Gemini model config (temperature, safety, etc.)
│       │   │   └── triageModel.ts                      # Builds the ChatGoogle triage model with thinking budget
│       │   ├── tools/
│       │   │   ├── getVideoCaptionsTool.ts             # LangChain tool: extracts video captions via yt-dlp
│       │   │   ├── getWebsiteTool.ts                   # LangChain tool: fetches and converts a web page to markdown
│       │   │   └── tavilySearchTool.ts                 # LangChain tool: web search via Tavily API
│       │   ├── utils/
│       │   │   └── inlineAttachmentFilter.ts           # Strips inline attachment blocks from messages before tool calls
│       │   ├── ModelProvider.ts                        # Returns the configured model instance for a given agent node
│       │   ├── ResilientModelInvoker.ts                # Invokes a model with per-key retry, fallback model, and timeout
│       │   ├── RoundRobinFreeKeyProvider.ts            # Rotates through free-tier API keys round-robin
│       │   └── SinglePaidKeyProvider.ts               # Wraps a single paid API key
│       └── logging/
│           ├── logger.ts                               # Pino logger singleton factory
│           └── withSentryLogging.ts                    # Logger wrapper that also reports errors to Sentry
│
├── tests/
│   ├── unit/                                           # Fast, in-process tests; no DB or network required
│   │   ├── application/                               # Tests for use cases, services, formatters, and helpers
│   │   ├── attachments/                               # Tests for attachment download and upload adapters
│   │   ├── discord/                                   # Tests for Discord gateway, rate limiter, formatting, etc.
│   │   ├── domain/                                    # Tests for domain errors and value objects
│   │   ├── llm/                                       # Tests for orchestrator, resilient invoker, and error detection
│   │   └── tools/                                     # Tests for LLM tool implementations
│   └── integration/
│       └── db/                                        # Integration tests that run against the test PostgreSQL DB
│
├── scripts/
│   ├── db/                                            # One-off data migration and backfill scripts (unused)
│   ├── dev/                                           # Local development utilities (render tests, API probes, etc.)
│   └── discord/
│       └── registerCommands.ts                        # Registers Discord slash / context menu commands with the API
│
├── drizzle.config.ts                                  # Drizzle Kit config (migration output path, DB connection)
├── config.default.yaml                                # Default configuration with all supported options documented
├── config.local.yaml                                  # Local overrides (gitignored)
├── Dockerfile                                         # Production image (includes yt-dlp and Deno for rendering)
├── docker-compose.local-dev.yml                       # Dev PostgreSQL instance (port 5432)
├── docker-compose.local-prod.yml                      # Local production-like stack
├── docker-compose.test.yml                            # Test PostgreSQL instance (port 5433)
├── ecosystem.config.cjs                               # PM2 process manager config for production
├── biome.json                                         # Biome linter / formatter config
├── tsconfig.json                                      # TypeScript compiler config
└── package.json                                       # Scripts, dependencies, bun workspaces
```
