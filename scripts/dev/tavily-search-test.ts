/**
 * Dev script for manually testing the Tavily search tool, including key rotation.
 * Reads the keys from TAVILY_API_KEYS (comma-separated) or TAVILY_API_KEY, in that order.
 * Saves the search results as pretty-printed JSON to a timestamped file in this directory.
 *
 * Run via: bunx cross-env AGENT=1 bun run scripts/dev/tavily-search-test.ts
 */

import pino from "pino";
import { toTavilyApiKeys } from "../../src/domain/entities/TavilyApiKey.ts";
import { RoundRobinKeyProvider } from "../../src/infrastructure/llm/RoundRobinKeyProvider.ts";
import { createTavilyTool } from "../../src/infrastructure/llm/tools/tavilySearchTool.ts";
import { KeyRotatingTavilySearch } from "../../src/infrastructure/search/KeyRotatingTavilySearch.ts";
import { TavilySearchClient } from "../../src/infrastructure/search/TavilySearchClient.ts";

const query = "Why can't chickens fly and what is the weather today like in london?";

const apiKeys = (process.env.TAVILY_API_KEYS ?? process.env.TAVILY_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
if (apiKeys.length === 0) throw new Error("Set TAVILY_API_KEYS or TAVILY_API_KEY");

const logger = pino();
const search = new KeyRotatingTavilySearch(
    new TavilySearchClient(logger),
    new RoundRobinKeyProvider(toTavilyApiKeys(apiKeys)),
    { maxResults: 10, searchDepth: "basic", chunksPerSource: 3, includeUsage: true },
    logger,
);

console.log(`Querying Tavily with ${apiKeys.length} key(s): "${query}"`);

const results = await createTavilyTool(logger, search).invoke({ query });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = `${import.meta.dir}/tavily-search-test-${timestamp}.json`;

await Bun.write(outPath, JSON.stringify(results, null, 2));

console.log(`Results saved to: ${outPath}`);
