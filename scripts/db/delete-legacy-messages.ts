/**
 * Deletes messages that still carry legacy Gemini file anchors, together with
 * every message that replies to them — recursively, down to the leaves of each
 * reply tree (see `lib/messageSubtrees.ts` for why the replies have to go too).
 *
 * A legacy anchor is a `gemini_files` row keyed by a raw Gemini URL instead of a
 * `discord://` token URL (rows written before the token refactor). Once deleted,
 * the next reply into such a thread re-fetches it from Discord and re-indexes its
 * media with token URLs.
 *
 * Run with:
 *   bun scripts/db/delete-legacy-messages.ts [--dry] [--url <connection string>]
 *
 *   --dry   Only count what would be deleted; nothing is modified.
 *   --url   Database to operate on. Defaults to DATABASE_URL (loaded from .env by Bun).
 *
 * Safe to re-run — once no legacy anchors remain there is nothing left to delete.
 */

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod/v4";
import type { Tx } from "./lib/messageSubtrees.ts";
import { deleteMessageSubtrees, parseCommonArgs } from "./lib/messageSubtrees.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

/** Counts the legacy anchors in the database. */
async function countLegacyFiles(tx: Tx): Promise<number> {
    const rows = await tx.execute(sql`
        SELECT count(*)::int AS "legacyFiles" FROM gemini_files WHERE original_gemini_url NOT LIKE 'discord://%'
    `);
    return z.object({ legacyFiles: z.number() }).parse(rows[0]).legacyFiles;
}

await deleteMessageSubtrees({
    ...parseCommonArgs(process.argv.slice(2)),
    logger,
    seedCondition: sql`EXISTS (
        SELECT 1 FROM gemini_files f
        WHERE f.message_id = m.id AND f.original_gemini_url NOT LIKE 'discord://%'
    )`,
    describeSeeds: async (tx) => logger.info({ legacyFiles: await countLegacyFiles(tx) }, "Legacy anchors found"),
    verify: async (tx) => {
        const legacyFiles = await countLegacyFiles(tx);
        if (legacyFiles !== 0) throw new Error(`Rolling back: ${legacyFiles} legacy anchors remain`);
    },
});
