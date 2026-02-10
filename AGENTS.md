# Practical Rules
- use bun commands instead of npm and node commands
- dont install dotenv, .env is loaded automatically by bun
- dont use the "any" type to resolve type errors, except where it actually makes sense logically
- use custom application errors instead of throwing generic errors when possible
- do not remove previous source code comments, unless you are changing the implementation or providing clarification or the user is asking you to
- use type imports for type only imports
- use ?? instead of || for optional chaining
- after implementing your task, run `bun run typecheck && bun run codecheck:fix && bun run test` and fix any errors until it passes all checks

# Architecture Rules
- use domain-driven design principles
- adhere to SOLID principles