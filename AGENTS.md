# General Rules
- use bun commands instead of npm and node commands
- dont install dotenv, .env is loaded automatically by bun
- dont use the "any" type to resolve type errors, except where it actually makes sense logically
- use custom application errors instead of throwing generic errors when possible
- do not remove previous source code comments, unless you are changing the implementation or providing clarification or the user is asking you to