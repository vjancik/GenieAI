/**
 * Shared machinery for scripts that delete a set of messages together with every
 * message replying to them — recursively, down to the leaves of each reply tree.
 *
 * The replies have to go with their parents: the history lookup walks a reply chain
 * upward and stops at the first missing row, and the live Discord fallback only runs
 * when that lookup returns nothing. Leaving a reply behind would keep a truncated
 * chain in place forever; removing the whole subtree lets the next reply into the
 * thread re-fetch it from Discord and rebuild it with the current pipeline.
 *
 * The subtree is collected by a single recursive CTE that starts at the seed messages
 * and follows `replies_to_discord_id` downward. `gemini_files`, `gemini_file_uploads`
 * and `message_pages` rows are removed by ON DELETE CASCADE. Collecting, counting,
 * deleting and verifying all happen in one transaction.
 */

import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod/v4";
import type { Db } from "../../../src/infrastructure/db/connection.ts";
import { createDb } from "../../../src/infrastructure/db/connection.ts";

/** A Drizzle transaction handle. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Signals a dry run: thrown inside the transaction so that it rolls back. */
class DryRunRollback extends Error {}

const countsSchema = z.object({
    seedMessages: z.number(),
    replyMessages: z.number(),
    totalMessages: z.number(),
    humanMessages: z.number(),
    assistantMessages: z.number(),
    geminiFiles: z.number(),
    geminiFileUploads: z.number(),
    messagePages: z.number(),
});

/** Number of rows a subtree deletion removes, directly or through cascades. */
export type SubtreeCounts = z.infer<typeof countsSchema>;

/**
 * Materializes the seed messages and the full set of messages to delete into two
 * temp tables (`seed_messages`, `doomed_messages`) that live until the transaction ends.
 *
 * The recursive step adds every message replying to a message already collected,
 * matched on the same guild + channel + Discord message ID the unique index is built
 * on. UNION (not UNION ALL) deduplicates, which also covers a seed replying to another seed.
 *
 * @param seedCondition - Boolean SQL expression over the `messages` alias `m` selecting the seeds
 */
async function collectDoomedMessages(tx: Tx, seedCondition: SQL): Promise<void> {
    await tx.execute(sql`
        CREATE TEMP TABLE seed_messages ON COMMIT DROP AS
        SELECT m.id FROM messages m WHERE ${seedCondition}
    `);
    await tx.execute(sql`
        CREATE TEMP TABLE doomed_messages ON COMMIT DROP AS
        WITH RECURSIVE doomed AS (
            SELECT m.id, m.guild_id, m.channel_id, m.discord_message_id
            FROM messages m
            WHERE m.id IN (SELECT id FROM seed_messages)
            UNION
            SELECT child.id, child.guild_id, child.channel_id, child.discord_message_id
            FROM messages child
            INNER JOIN doomed parent
                ON  child.guild_id   = parent.guild_id
                AND child.channel_id = parent.channel_id
                AND child.replies_to_discord_id = parent.discord_message_id
        )
        SELECT id FROM doomed
    `);
}

/** Counts the collected messages and the dependent rows the cascade will remove. */
async function countAffected(tx: Tx): Promise<SubtreeCounts> {
    const rows = await tx.execute(sql`
        WITH doomed AS (
            SELECT m.id, m.role, m.id IN (SELECT id FROM seed_messages) AS is_seed
            FROM messages m
            WHERE m.id IN (SELECT id FROM doomed_messages)
        ),
        files AS (
            SELECT f.id FROM gemini_files f WHERE f.message_id IN (SELECT id FROM doomed)
        )
        SELECT
            (SELECT count(*) FROM doomed WHERE is_seed)::int            AS "seedMessages",
            (SELECT count(*) FROM doomed WHERE NOT is_seed)::int        AS "replyMessages",
            (SELECT count(*) FROM doomed)::int                          AS "totalMessages",
            (SELECT count(*) FROM doomed WHERE role = 'human')::int     AS "humanMessages",
            (SELECT count(*) FROM doomed WHERE role = 'assistant')::int AS "assistantMessages",
            (SELECT count(*) FROM files)::int                           AS "geminiFiles",
            (SELECT count(*) FROM gemini_file_uploads u
                WHERE u.gemini_file_id IN (SELECT id FROM files))::int  AS "geminiFileUploads",
            (SELECT count(*) FROM message_pages p
                WHERE p.message_id IN (SELECT id FROM doomed)
                   OR p.first_page_message_id IN (SELECT id FROM doomed))::int AS "messagePages"
    `);
    return countsSchema.parse(rows[0]);
}

/** Counts the targeted messages still present after the delete; must be zero. */
async function countRemainingMessages(tx: Tx): Promise<number> {
    const rows = await tx.execute(sql`
        SELECT count(*)::int AS "remaining" FROM messages WHERE id IN (SELECT id FROM doomed_messages)
    `);
    return z.object({ remaining: z.number() }).parse(rows[0]).remaining;
}

/** Describes a connection string without its credentials, for logging. */
function describeTarget(url: string): string {
    const { hostname, port, pathname } = new URL(url);
    return `${hostname}:${port || "5432"}${pathname}`;
}

/**
 * Reads the options shared by all subtree deletion scripts from the command line.
 *
 *   --dry   Only count what would be deleted; nothing is modified.
 *   --url   Database to operate on. Defaults to DATABASE_URL (loaded from .env by Bun).
 */
export function parseCommonArgs(args: string[]): { dryRun: boolean; url: string } {
    const urlFlagIndex = args.indexOf("--url");
    const url = urlFlagIndex === -1 ? process.env.DATABASE_URL : args[urlFlagIndex + 1];
    if (!url) throw new Error("No database given: pass --url <connection string> or set DATABASE_URL");
    return { dryRun: args.includes("--dry"), url };
}

/**
 * Deletes the messages matched by `seedCondition` together with their reply subtrees.
 *
 * @param options.url - Connection string of the database to operate on
 * @param options.dryRun - When true, counts are reported and the transaction is rolled back
 * @param options.seedCondition - Boolean SQL expression over the `messages` alias `m` selecting the seeds
 * @param options.logger - Logger for progress and counts
 * @param options.describeSeeds - Optional hook run once the temp tables exist, to log script-specific details about the seeds
 * @param options.verify - Optional hook run after the delete; throwing rolls the whole deletion back
 * @returns The affected row counts (identical for dry and real runs)
 */
export async function deleteMessageSubtrees(options: {
    url: string;
    dryRun: boolean;
    seedCondition: SQL;
    logger: Logger;
    describeSeeds?: (tx: Tx) => Promise<void>;
    verify?: (tx: Tx) => Promise<void>;
}): Promise<SubtreeCounts> {
    const { url, dryRun, seedCondition, logger, describeSeeds, verify } = options;
    logger.info({ target: describeTarget(url), dryRun }, "Deleting matched messages and their reply subtrees");

    const db = createDb(url);
    let counts: SubtreeCounts | null = null;

    try {
        await db.transaction(async (tx) => {
            await collectDoomedMessages(tx, seedCondition);
            await describeSeeds?.(tx);
            counts = await countAffected(tx);
            logger.info(counts, dryRun ? "Would delete (dry run)" : "Deleting");

            if (dryRun) throw new DryRunRollback();
            if (counts.totalMessages === 0) return;

            await tx.execute(sql`DELETE FROM messages WHERE id IN (SELECT id FROM doomed_messages)`);

            // A leftover row means the subtree or the cascade missed something — abort rather than commit a partial cleanup
            const remaining = await countRemainingMessages(tx);
            if (remaining !== 0) throw new Error(`Delete incomplete, rolling back: ${remaining} messages remain`);
            await verify?.(tx);
            logger.info("Deleted");
        });
    } catch (err) {
        if (!(err instanceof DryRunRollback)) throw err;
        logger.info("Dry run complete — nothing was modified");
    } finally {
        await db.$client.close();
    }

    if (counts === null) throw new Error("Deletion ended without producing counts");
    return counts;
}
