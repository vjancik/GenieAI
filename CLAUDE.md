# Environment Rules
- use bun commands instead of npm and node commands
- when using any bun command prepend it with `bunx cross-env AGENT=1` (for example: `bunx cross-env AGENT=1 bun run test`)
- after implementing your task, run `bun typecheck && bun codecheck:fix && bun run test` and fix any errors until it passes all checks
- use US English spelling over British English spelling

# Code Architecture Rules
- use Domain-Driven Design principles and adhere to Hexagonal Architecture
- dependencies should flow as Infrastructure -> Application -> Domain, anytime a reverse direction is needed, depend on an abstraction (type import of an interface)
- adhere to SOLID principles
- the code you write should be easy to test by being decoupled and easy to mock, prefer DI over hardwired dependencies
- always write unit tests for code involving non-trivial transformations
- use custom application errors instead of throwing generic errors when possible
- write comments for any non-trivial code consistently explaining it's purpose and functionality
- use JSDoc comments for public / exported functions and modules, or any callables with many or complex parameters
- use consistent logging throughout the application code base through a centralized, configurable, logging provider

# Node.js (Bun) / Typescript Specific Rules
- use type imports for type only imports
- use ?? instead of || for nullish coalescing
- don't install dotenv, .env is loaded automatically by bun
- don't use the "any" type to resolve type errors, except where it actually makes sense logically
- any type coercions must have a preceding comment explaining why they are necessary or acceptable in the format // TYPE COERCION: ..., this applies to project source code, tests are an exception
- use type guards and type narrowing over type coercions where possible
- prefer bind(this / instanceObj), when passing methods as callbacks, to lambda wrappers

# Database Rules
- prefer prepared statements for repeated queries
- prefer timestamps with timezones over regular timestamps
- prefer uuidv7 over uuidv4 

# Third-Party APIs & SDKs Rules
- use `context7` MCP to look up up-to-date API docs and usage patterns for major libraries (e.g. langchain, @langchain/google, genai) before writing code using them, or when trying to resolve type discrepancies  