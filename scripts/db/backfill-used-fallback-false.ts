/**
 * Backfill script: set usedFallback = false for assistant messages where it is NULL
 * and retriesLeft is NULL or 0 (i.e. non-retryable responses, predating the column).
 *
 * Run with:
 *   bun scripts/db/backfill-used-fallback-false.ts
 *
 * Requires DATABASE_URL (loaded automatically from .env by Bun).
 * Idempotent — only rows with usedFallback IS NULL are touched.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../../src/infrastructure/db/connection.ts";
import { messages } from "../../src/infrastructure/db/schema.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

const db = createDb();

await db
    .update(messages)
    .set({ usedFallback: false })
    .where(
        and(
            eq(messages.role, "assistant"),
            isNull(messages.usedFallback),
            or(isNull(messages.retriesLeft), eq(messages.retriesLeft, 0)),
        ),
    );

logger.info("Backfill complete");

await db.$client.end();
