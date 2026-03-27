# Genie AI

A Discord bot powered by Google Gemini that answers questions in multi-turn reply threads. Genie uses a lightweight triage model to decide whether to fetch web pages, fetch video captions from links, use a search engine, or answer directly — then routes to a stronger model for the final response.

## Table of Contents

- [Features](#features)
- [Agent](#agent)
- [Requirements](#requirements)
- [Environment Variables](#environment-variables)
- [Configuration](#configuration)
- [Discord Setup](#discord-setup)
- [Deploy with Docker](#deploy-with-docker)
- [Observability](#observability)
- [Development](#development)
- [Caveats & Shortcomings](#caveats--shortcomings)
- [Q&A](#qa)

## Features

- Responds to explicit @mentions and `!ai` / `!aisearch` command prefixes in guilds and DMs.
- Uses Discord reply-chains as conversation context, allows branching at any point; Persisted in PostgreSQL.
- Automatically fetches and reads web pages linked in messages (static only, HTML & text).
- Extracts captions and transcripts from YouTube and other video URLs via `yt-dlp` for video content summaries and questions.
- Searches the web using Google Search grounding or Tavily, and cites sources.
- Processes ANY Discord file attachments that Gemini accepts (images, videos, PDFs, etc.) passed directly in messages.
- Paginates long responses with a **Next Page** button; Renders math and tables as images or HTML.
- Retry button on failed or degraded responses, with definable fallback models.
- Right-click context menu commands: **Summarize**, **Export as HTML**, **Export as Image**.
- Fully configurable via a single YAML file — models, timeouts, search backend.
- Usable with one **paid** Google API key or one or more **free** API keys used in rotation.
- Uploads all files to Gemini File API for extremely fast LLM responses despite large attachments thanks to 48 hour file caching.

**...and more**

## Agent

### How triggers map to start nodes

| Trigger | Intent | Graph entry point |
|---|---|---|
| `@mention` (no prefix) | `UNKNOWN` | → **Triage** (model decides) |
| `!ai` | `GENERAL` | → **General** directly (triage skipped) |
| `!aisearch` | `SEARCH` | → **Search** directly (triage skipped, or via Triage in Tavily mode) |
| Context menu: Summarize | `SUMMARY` | → **Triage** (model decides), with an ephemeral *"Summarize this in English"* instruction |

### Graph topology

```mermaid
flowchart TD
    START(["START"])
    TRIAGE["Triage\n(fast model, thinking)"]
    FETCH["Fetch Content\n(get_website / get_video_captions)"]
    GENERAL["General\n(answer model)"]
    SEARCH["Search\n(search model + grounding)"]
    END(["END"])

    START -- "UNKNOWN / SUMMARY intent" --> TRIAGE
    START -- "!ai (GENERAL intent)" --> GENERAL
    START -- "!aisearch, Google mode (SEARCH intent)" --> SEARCH
    START -- "!aisearch, Tavily mode (SEARCH intent)" --> TRIAGE

    TRIAGE -- "route_to_general" --> GENERAL
    TRIAGE -- "route_to_search (Google)" --> SEARCH
    TRIAGE -- "web_search tool call (Tavily)" --> SEARCH
    TRIAGE -- "get_website / get_video_captions" --> FETCH

    FETCH --> GENERAL

    GENERAL --> END
    SEARCH --> END
```

**Triage** is a lightweight model. It inspects only the latest turn and chooses one of four actions:

- Call `get_website` or `get_video_captions` → **Fetch Content**, then **General**
- Call `route_to_search` → **Search** directly
- Call `route_to_general` → **General** directly
- No tool call (fallback) → **General** directly

Routing sentinel calls (`route_to_search`, `route_to_general`) are consumed by the triage node and are never written to message state, keeping conversation history clean. Real tool calls (`get_website`, `get_video_captions`, `web_search`) are added to state so their `ToolMessage` responses have valid `tool_call_id` pairings.

## Requirements

- [Docker](https://docs.docker.com/get-docker/) — for the full stack (DB + app); **or** [Bun](https://bun.sh) ≥ 1.3 + [PostgreSQL](https://www.postgresql.org/) ≥ 18 + [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Deno](https://deno.com/), and Chromium (for Playwright) installed on the host
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A Google AI API key ([Google AI Studio](https://aistudio.google.com))

### System requirements (Recommended)

| Setup | vCPU | RAM |
|---|---|---|
| Bot + DB (full stack) | 2 | 512 MB |
| Bot only (external DB) | 1 | 512 MB |

The bot embeds Playwright (for HTML-to-image rendering) and bundles `yt-dlp`, both of which contribute to the memory footprint.

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values.

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Application ID from the Discord Developer Portal |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `GOOGLE_FREE_API_KEYS` | ✅* | Comma-separated free-tier Google AI API keys (required when any agent node uses `apiKeyType: "free"`) |
| `GOOGLE_PAID_API_KEY` | ✅* | Single paid Google AI API key (required when any agent node uses `apiKeyType: "paid"`) |
| `TAVILY_API_KEY` | | Tavily API key — required only when `agent.nodes.search.mode` is set to `"tavily"` |
| `LOG_LEVEL` | | Pino log level: `trace`, `debug`, `info`, `warn`, `error` (default: `info`) |
| `FILE_LOG` | | Write structured JSON logs to `./logs/` alongside console output (default: `false`) |
| `NODE_ENV` | | Set to `production` to disable pino-pretty and output raw JSON |
| `CONFIG_PATH` | | Path to config YAML file (default: `config.local.yaml` in the working directory) |
| `SENTRY_URL` | | Sentry DSN — enables error and performance monitoring when set |

## Configuration

All bot behaviour is controlled by a YAML config file. [`config.default.yaml`](config.default.yaml) contains every supported option with inline comments explaining what each one does. To customise:

```bash
cp config.default.yaml config.local.yaml
# edit config.local.yaml
```

`config.local.yaml` is loaded automatically and is gitignored. In Docker, mount your file and point `CONFIG_PATH` at it (see [Deploy with Docker](#deploy-with-docker)).

Key things to configure:

- **Models** — set the Gemini model and `apiKeyType` (`"free"` / `"paid"`) for each of the three agent nodes (`triage`, `general`, `search`)
- **Search backend** — `agent.nodes.search.mode`: `"google"` (Gemini grounding) or `"tavily"`
- **Attachment mode** — `agent.uploadAttachmentMode`: `"upload"` (Gemini Files API) or `"inline"` (base64)
- **DMs** — `discord.enableInDMs: true` to allow the bot to respond in Direct Messages
- **System prompt** — `prompts.basePrompt` to customise the bot's persona and instructions

## Discord Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), enable the **Message Content** privileged intent for your application.
2. Invite the bot to your server with the `bot` scope and the following permissions:
   - **Attach Files**, **Manage Messages**, **Read Message History**, **Send Messages** (required)
   - **Send Messages in Threads** (optional — required only if you want the bot to respond inside threads)
3. Mention the bot in any channel to start a conversation:
   > `@Genie what is the capital of France?`

Genie only responds to explicit @mentions or `!ai` / `!aisearch` prefixes — replying to a message without including `@Genie` will not trigger it.

## Deploy with Docker

### Run locally with docker-compose

The included `docker-compose.local.yml` starts a PostgreSQL database and the bot together, building the image from source. If you don't want to or can't build the image yourself, `docker-compose/docker-compose.local-prebuilt.yml` uses the prebuilt image from Docker Hub (`vjancik/genieai:main`) instead — note it is currently only available for `linux/amd64` and `linux/arm64` architectures.

**1. Prepare your files**

```bash
cp .env.example .env          # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, GOOGLE_*_API_KEY(S)
cp config.default.yaml config.local.yaml  # customise models, search backend, etc.
```

`DATABASE_URL` is set automatically by the compose file — do not add it to `.env`.

**2. Start the stack**

Migrations run automatically before the app starts.

```bash
docker compose -f docker-compose.local.yml up -d --build
# or equivalently:
bun local:up
```

To stop:

```bash
docker compose -f docker-compose.local.yml down
# or equivalently:
bun local:down
```

### Deploy to a cloud provider

Any platform that can run a Docker container or Docker Compose stack is supported:

- **[Render](https://render.com/docs/docker)** — deploy via Dockerfile
- **[Railway](https://docs.railway.com/builds/dockerfiles)** — deploy via Dockerfile
- **[Dokploy](https://dokploy.com)** (self-hosted, VPC) — via [Docker Compose](https://docs.dokploy.com/docs/core/docker-compose) or [Dockerfile + managed DB](https://docs.dokploy.com/docs/core/databases)
- **[Coolify](https://coolify.io)** (self-hosted, VPC) — via [Dockerfile](https://coolify.io/docs/applications/build-packs/dockerfile) or [Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)

`DATABASE_URL` can point to an external PostgreSQL provider such as [Neon](https://neon.tech), [Supabase](https://supabase.com), or [Prisma Postgres](https://www.prisma.io/postgres) (all untested) if you prefer not to manage the database yourself.

## Observability

### LangSmith

[LangSmith](https://smith.langchain.com) provides real-time tracing of every agent execution — node transitions, tool calls, model inputs/outputs, latency, and token usage — without any code changes. LangChain picks it up automatically from environment variables:

```env
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=<your-api-key>
LANGSMITH_PROJECT=genie-ai
```

Add these to your `.env` (or the container environment) and all agent runs will appear in the LangSmith dashboard. A free tier is available.

### Sentry

[Sentry](https://sentry.io) provides exception monitoring, performance tracing, and alerting. Set `SENTRY_URL` to your project DSN to enable it:

```env
SENTRY_URL=https://<key>@sentry.io/<project>
```

Alerts can be routed to email, a Discord webhook, Slack, and many others via Sentry's alert rules. The LangChain callback handler is also wired in, so Sentry traces include agent span data alongside application errors.

## Development

### Run tests

> **Never run `bun test` directly** — it loads `.env` by default, which may point to your production database.
> Always use `bun run test` (uses `.env.test`) or the filter patterns below.

```bash
# Unit tests (no database required)
bun run test tests/unit/

# Integration tests (requires test database)
bun db:test:up && bun db:test:migrate
bun run test tests/integration/

# Filter by test name pattern
bun run test -t "pattern"

# Full suite
bun run test
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
bun db:studio      # Runs Drizzle Kit Database Web UI (default port 4983, works with VS Code port forwarding on Remotes)
```

### Further reading

- [docs/features.md](docs/features.md) — Full (arguably) user-facing feature reference
- [docs/file-tree.md](docs/file-tree.md) — Annotated source file tree
- [docs/code-statistics.md](docs/code-statistics.md) — Line count breakdown

## Caveats & Shortcomings

- **Not suitable for large public servers.** There are no per-user or per-channel access controls, allowlists, or token budgets. Anyone who can mention the bot can use it without restriction.
- **Gemini API reliability.** Since early 2026, Gemini models have been notably flaky — HTTP 503 responses and response times of up to a minute during peak hours are common. The resilient invoker retries on 503s and rotates free keys on 429s, but sustained outages will still surface as failures.
- **Inline attachment mode is second-class.** `inline` mode re-downloads all attachments in the conversation on every turn (no disk cache), and encodes them as base64 in the request. It was added as a cross-provider fallback; `upload` mode (Gemini Files API with 48-hour caching) is strongly preferred.
- **Gemini 3 tool call hallucinations.** Gemini 3 models occasionally hallucinate tool calls in Tavily search mode in nodes where tool use is not expected (general and search nodes). This causes a hard failure that requires the user to hit Retry.

## Q&A

**Q: How do I make video captions with yt-dlp work on a cloud server?**

A: You need a rotating residential proxy, otherwise YouTube will flag the server as a bot and caption downloading will fail. [Webshare](https://webshare.io/) starts at around $1/month for 1 GB of traffic, which is more than enough for caption text files. Once you have a proxy URL, set it in `config.local.yaml`:

```yaml
ytDlp:
  httpProxy: "http://user-US-rotate:pass@p.webshare.io"
```

---

**Q: Can this bot be hosted with a serverless provider?**

A: Any host that supports running Docker containers can run this bot. `DATABASE_URL` can point to an external PostgreSQL provider like [Neon](https://neon.tech), [Supabase](https://supabase.com), or [Prisma Postgres](https://www.prisma.io/postgres) (all untested), removing the need to run the DB container yourself. A fully serverless setup (e.g. Lambda, Cloud Run) is not viable — the bot requires a persistent process for the Discord gateway connection, and the bundled `yt-dlp`, Deno, and Playwright binaries are not compatible with ephemeral function environments. Cloudflare Workers also won't work because it doesn't support the Bun runtime.
