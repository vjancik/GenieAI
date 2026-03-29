/**
 * Removes legacy sources follow-up messages from Discord and the DB.
 *
 * Before the Sources button was introduced, web-search responses emitted a
 * separate bot message whose content matched `*Sources: ...*)` (italic markdown,
 * one or more hyperlinks). These messages are stored as "assistant" rows with an
 * empty langchain_messages array (placeholder rows).
 *
 * This script:
 *   1. Paginates over all assistant rows in the DB using id-keyset pagination.
 *   2. Skips rows whose langchain_messages array is non-empty (not placeholder rows).
 *   3. For each placeholder row, fetches the Discord message and checks whether its
 *      content matches the sources-message pattern.
 *   4. If it matches: deletes the Discord message and the DB row.
 *   5. Logs a summary on completion.
 *
 * Run with:
 *   bun scripts/discord/removeSourcesMessages.ts
 *
 * Requires DATABASE_URL and DISCORD_TOKEN (loaded automatically from .env by Bun).
 * Safe to re-run — rows already deleted are simply skipped.
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { and, eq, gt } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../../src/infrastructure/db/connection.ts";
import { messages } from "../../src/infrastructure/db/schema.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

/** Matches the sources line format: `*Sources: [Title](<url>), ...*)` */
const SOURCES_MESSAGE_RE = /^\*Sources: .+\)\*$/s;

const BATCH_SIZE = 10;

// ─── Setup ────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN env var is required");

const db = createDb(process.env.DATABASE_URL ?? "");

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

await new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, () => resolve());
    client.once(Events.Error, reject);
    client.login(token).catch(reject);
});

logger.info({ tag: client.user?.tag }, "Discord client ready");

// ─── Process ──────────────────────────────────────────────────────────────────

let deleted = 0;
let skipped = 0;
let notFound = 0;
let processed = 0;

// Keyset-paginated cursor over assistant rows, ordered by id ASC.
// id is unique so the cursor always advances — every row is processed exactly once.
const baseCondition = eq(messages.role, "assistant");

let cursor: string | null = null;

while (true) {
    const batch = await db
        .select({
            id: messages.id,
            discordMessageId: messages.discordMessageId,
            channelId: messages.channelId,
            guildId: messages.guildId,
            langchainMessages: messages.langchainMessages,
        })
        .from(messages)
        .where(cursor !== null ? and(baseCondition, gt(messages.id, cursor)) : baseCondition)
        .orderBy(messages.id)
        .limit(BATCH_SIZE);

    logger.info({ batchSize: batch.length, cursor }, "Fetched batch");

    if (batch.length === 0) break;

    // TYPE COERCION: safe — last element always exists when batch.length > 0.
    cursor = (batch.at(-1) as (typeof batch)[number]).id;

    for (const row of batch) {
        processed++;

        // Only placeholder rows (empty langchain_messages) are legacy sources messages.
        if ((row.langchainMessages as unknown[]).length > 0) {
            skipped++;
            continue;
        }

        let content: string;
        let discordDeleteFn: (() => Promise<void>) | null = null;

        try {
            const channel = await client.channels.fetch(row.channelId);
            if (!channel?.isTextBased()) {
                logger.warn({ channelId: row.channelId }, "Channel not found or not text-based — skipping");
                notFound++;
                continue;
            }
            // TYPE COERCION: isTextBased() narrows to TextBasedChannel which exposes .messages,
            // but TypeScript's union doesn't surface it directly without a cast.
            const msg = await (
                channel as {
                    messages: { fetch: (id: string) => Promise<{ content: string; delete(): Promise<unknown> }> };
                }
            ).messages.fetch(row.discordMessageId);
            content = msg.content;
            discordDeleteFn = () => msg.delete().then(() => {});
        } catch {
            logger.warn(
                { discordMessageId: row.discordMessageId, channelId: row.channelId },
                "Discord message not found — deleting DB row only",
            );
            // Message already deleted from Discord — clean up the orphaned DB row regardless.
            await db.delete(messages).where(eq(messages.id, row.id));
            deleted++;
            continue;
        }

        if (!SOURCES_MESSAGE_RE.test(content)) {
            skipped++;
            continue;
        }

        // Delete from Discord first, then from DB.
        try {
            await discordDeleteFn?.();
        } catch (err) {
            logger.warn({ discordMessageId: row.discordMessageId, err }, "Failed to delete Discord message — skipping");
            continue;
        }

        await db.delete(messages).where(eq(messages.id, row.id));
        deleted++;

        logger.info({ discordMessageId: row.discordMessageId }, "Deleted sources message");
    }
}

client.destroy();
await db.$client.end();

logger.info({ deleted, skipped, notFound, processed }, "Done");
