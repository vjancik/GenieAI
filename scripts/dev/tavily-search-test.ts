/**
 * Dev script for manually testing the Tavily search tool.
 * Saves the raw result as pretty-printed JSON to a timestamped file in this directory.
 *
 * Run via: bunx cross-env AGENT=1 bun run scripts/dev/tavily-search-test.ts
 */

import { createTavilyTool } from "../../src/infrastructure/llm/tools/tavilySearchTool.ts";

const query = "Why can't chickens fly and what is the weather today like in london?";

console.log(`Querying Tavily: "${query}"`);

const results = await createTavilyTool().invoke({ query });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = `${import.meta.dir}/tavily-search-test-${timestamp}.json`;

await Bun.write(outPath, JSON.stringify(results, null, 2));

console.log(`Results saved to: ${outPath}`);
