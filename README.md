# Genie AI

A Discord bot powered by Google Gemini that answers questions in reply threads. Genie uses a lightweight triage model to decide whether to fetch web pages, transcribe videos, search the web, or answer directly — then routes to a stronger model for the final response.

## Features

- Responds to explicit @mentions in guilds and DMs
- Fetches and summarises URLs (via `get_website` tool)
- Transcribes YouTube/video URLs (via `yt-dlp`)
- Searches the web using Google Search grounding
- Maintains per-thread conversation history via PostgreSQL reply-chain reconstruction

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Docker](https://docs.docker.com/get-docker/) (for the database)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (for video transcription)
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A Google AI API key ([Google AI Studio](https://aistudio.google.com))

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable                              | Required | Default    | Description                                                                                                   |
|---------------------------------------|----------|------------|---------------------------------------------------------------------------------------------------------------|
| `DISCORD_TOKEN`                       | ✅       |            | Bot token from the Discord Developer Portal                                                                   |
| `GOOGLE_API_KEY`                      | ✅       |            | Google AI API key                                                                                             |
| `DATABASE_URL`                        | ✅       |            | PostgreSQL connection string                                                                                  |
| `TRIAGE_THINKING_LEVEL`               |          | `minimal`  | Thinking level for the triage model                                                                           |
| `INCLUDE_LLM_THOUGHTS`               |          | `false`    | Expose raw LLM thought tokens in responses and traces (increases latency)                                     |
| `LOG_LEVEL`                           |          | `info`     | Pino log level: `trace`, `debug`, `info`, `warn`, `error`                                                    |
| `FILE_LOG`                            |          | `false`    | Write structured JSON logs to `./logs/<timestamp>-pino.log` in parallel with console output                  |
| `UPLOAD_ATTACHMENT_MODE`              |          | `upload`   | `inline` — base64 in message (cross-provider); `upload` — Gemini Files API (lower memory, Gemini only)       |
| `MAX_INLINE_ATTACHMENT_SZ_MB`         |          | `100`      | Max total MB of inline attachment data per message and across conversation history                            |
| `GEMINI_FILE_STALE_THRESHOLD_MINUTES` |          | `60`       | Minutes before Gemini file expiry to consider a file stale and re-upload (only when `UPLOAD_ATTACHMENT_MODE=upload`) |
| `NODE_ENV`                            |          |            | Set to `production` to disable pino-pretty (output raw JSON)                                                 |

### 3. Start the database

```bash
bun db:up
bun db:migrate
```

### 4. Run the bot

```bash
bun start
```

## Discord Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), enable the **Message Content** privileged intent for your application.
2. Invite the bot to your server with the `bot` scope and the `Send Messages` / `Read Message History` permissions.
3. Mention the bot in any channel to start a conversation: `@Genie what is the capital of France?`

Genie only responds to explicit @mentions — replying to one of its messages without typing `@Genie` will not trigger it.

## Development

### Run tests

```bash
# Unit tests (no database required)
bun test tests/unit/

# Integration tests (requires test database)
bun db:test:up
bun db:test:migrate
bun test tests/integration/

# Full test suite
bun test
```

### Type check & lint

```bash
bun typecheck
bun codecheck:fix
```

### Database management

```bash
bun db:up          # Start dev database (Docker)
bun db:down        # Stop dev database
bun db:generate    # Generate migrations from schema changes
bun db:migrate     # Apply pending migrations
```

## Architecture

```
src/
├── domain/                  # Entities, interfaces, errors (no dependencies)
│   ├── errors/AppError.ts
│   └── message/
│       ├── Message.ts
│       └── IMessageRepository.ts
├── application/             # Use cases
│   └── HandleDiscordMention.ts
└── infrastructure/          # Adapters (DB, LLM, Discord)
    ├── config/config.ts
    ├── logging/logger.ts
    ├── db/
    │   ├── schema.ts
    │   ├── connection.ts
    │   └── repositories/PgMessageRepository.ts
    ├── llm/
    │   ├── agents/          # triageAgent, searchAgent, generalAgent
    │   ├── tools/           # getWebsiteTool, getVideoTranscriptionTool
    │   └── orchestrator.ts
    └── discord/DiscordGateway.ts
```

Each Discord reply chain is an isolated conversation thread. When the bot is mentioned in a reply, it reconstructs the full conversation history using a recursive CTE that walks the `replies_to_discord_id` chain back to the root.

## Code Statistics

Generated by `bun scripts/dev/count-lines.ts`. Counts non-blank, non-comment lines as code.

| Category | Files | Total Lines | Code Lines | Comment Lines | Blank Lines |
|----------|------:|------------:|-----------:|--------------:|------------:|
| Source   |    78 |      11,284 |      6,649 |         3,622 |       1,013 |
| Tests    |    30 |       7,585 |      5,986 |           571 |       1,028 |
| **Total**|  **108** |  **18,869** | **12,635** |     **4,193** |   **2,041** |
