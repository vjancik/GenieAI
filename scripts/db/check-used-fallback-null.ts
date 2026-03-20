/**
 * Check script: counts assistant message rows where usedFallback is still NULL.
 * A count of 0 means all assistant messages have been backfilled.
 *
 * Run with:
 *   bun scripts/db/check-used-fallback-null.ts
 *
 * Requires DATABASE_URL (loaded automatically from .env by Bun).
 */

import { and, count, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../../src/infrastructure/db/connection.ts";
import { messages } from "../../src/infrastructure/db/schema.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

const db = createDb(process.env.DATABASE_URL ?? "");

const [row] = await db
    .select({ nullCount: count() })
    .from(messages)
    .where(and(eq(messages.role, "assistant"), isNull(messages.usedFallback)));

logger.info({ nullCount: row?.nullCount ?? 0 }, "Assistant rows with NULL usedFallback");

await db.$client.end();
