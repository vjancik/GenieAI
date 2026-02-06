# Architecture Design: AI Agent Backend (DDD)

## Top-Level Goals
- **Decoupling**: The core logic (Agent reasoning) should be independent of the interface (Discord, Web, CLI) and the infrastructure (DB, LLM Provider).
- **Scalability**: Easy to add new capabilities (tools), new interfaces (Slack, Telegram), or switch LLM providers.
- **Testability**: Domain logic can be unit tested without spinning up a Discord bot or making real API calls.

## Proposed Folder Structure
```text
src/
├── config/                 # Environment variables and configuration
├── core/                   # The Heart of the application (Domain + Application)
│   ├── domain/             # Enterprise business rules (Entities, Value Objects)
│   │   ├── entities/       # e.g., Agent, Conversation, Message
│   │   ├── events/         # Domain events e.g., MessageReceived, AgentThinking
│   │   ├── repositories/   # Interfaces for persistence (IRepository)
│   │   ├── services/       # Domain services (logic that doesn't fit in an entity)
│   │   └── value-objects/  # Immutable objects e.g., ModelParams, UserID
│   └── application/        # Application business rules (Use Cases)
│       ├── dtos/           # Data Transfer Objects
│       ├── interfaces/     # Ports for infrastructure (ILLMProvider, IVectoreStore)
│       └── use-cases/      # Application logic e.g., ProcessUserMessage, SummarizeChat
├── infrastructure/         # External concerns (Adapters)
│   ├── ai/                 # LLM implementations (OpenAI, Anthropic)
│   ├── database/           # DB implementations (Postgres via Prisma/Drizzle, or Bun:SQLite)
│   ├── memory/             # Vector store adapters, Redis cache
│   ├── logging/            # Logger implementation
│   └── tools/              # Concrete implementations of Agent Tools (Search, Calculator)
├── interfaces/             # Entry points (Driving Adapters)
│   ├── discord/            # Discord Bot Consumer
│   │   ├── commands/
│   │   ├── events/
│   │   └── index.ts        # Discord entry point
│   ├── http/               # Optional REST API (Fastify/Elysia)
│   └── cli/                # Optional CLI for debugging
├── shared/                 # Shared kernel
│   ├── errors/             # Custom error types
│   ├── types/              # Shared utility types
│   └── utils/              # Common helper functions
└── index.ts                # Main Composition Root (Dependency Injection setup)
```

## Detailed Layer Responsibilities

### 1. Core / Domain
Pure TypeScript. **NO dependencies** on frameworks, libraries, or external APIs.
- **Entities**: `User`, `AgentContext`
- **Value Objects**: `Content`, `Role` (system/user/assistant)
- **Repository Interfaces**: `IChatRepository`, `IMemoryRepository`

### 2. Core / Application
Orchestration layer. It tells the domain what to do using repositories and services.
- **Use Cases**: 
    - `SendMessageUseCase`: Input -> (DTO) -> Validate -> Load History -> Call LLM -> Save -> Output.
    - `IngestMemoryUseCase`: Store facts into the vector DB.
- **Ports**: Definitions of what we need from the outside world (e.g., `IGenerativeAIModel`).

### 3. Infrastructure
Implementations of the interfaces defined in core.
- **AI Adapter**: Implements `IGenerativeAIModel`. Uses `openai` sdk or `langchain` (wrapped).
- **Database**: Implements `IChatRepository`.
- **Tools**: Real implementation of tools the agent can use.

### 4. Interfaces (Presentation)
Where the app starts.
- **Discord**: Listens to `messageCreate`, calls `SendMessageUseCase`.
- **HTTP**: POST /chat calls `SendMessageUseCase`.

## Dependency Injection (Composition Root)
Since we are using Bun, we can keep it simple. `src/index.ts` will constitute the **Composition Root**.
It will:
1. Instantiate Infrastructure (db, env, ai adapter).
2. Instantiate Application Services (injecting infra).
3. Instantiate Interfaces (injecting app services).
4. Start the interfaces.
