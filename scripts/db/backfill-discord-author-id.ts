/**
 * Backfill script for discord_author_id.
 *
 * Fetches all messages rows where discord_author_id is '' (the column default),
 * resolves the real author ID from Discord, and writes it back.
 *
 *   - assistant rows: use the bot's own Discord user ID (client.user.id)
 *   - human rows: fetch the original Discord message and use message.author.id
 *   - Rows whose Discord message was deleted are left as '' so the NOT NULL
 *     constraint is still satisfied when the default is removed later.
 *
 * Run with:
 *   bun scripts/backfill-discord-author-id.ts
 *
 * Requires DATABASE_URL and DISCORD_TOKEN (loaded automatically from .env by Bun).
 * The script is idempotent — only rows with discord_author_id = '' are touched.
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../../src/infrastructure/db/connection.ts";
import { messages } from "../../src/infrastructure/db/schema.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

// ─── Setup ────────────────────────────────────────────────────────────────────

const db = createDb();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN env var is required");

// Fetch only the columns needed — no langchain_messages (can be large).
const emptyRows = await db
    .select({
        id: messages.id,
        discordMessageId: messages.discordMessageId,
        channelId: messages.channelId,
        role: messages.role,
    })
    .from(messages)
    .where(eq(messages.discordAuthorId, ""));

if (emptyRows.length === 0) {
    logger.info("No rows with empty discord_author_id — nothing to backfill");
    await (db as unknown as { $client: { end?: () => Promise<void> } }).$client?.end?.();
    process.exit(0);
}

logger.info({ count: emptyRows.length }, "Rows to backfill");

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
});

await new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, () => resolve());
    client.once(Events.Error, reject);
    client.login(token).catch(reject);
});

// biome-ignore lint/style/noNonNullAssertion: client.user is guaranteed non-null after ClientReady fires
const botUserId = client.user!.id;
// biome-ignore lint/style/noNonNullAssertion: client.user is guaranteed non-null after ClientReady fires
logger.info({ botUserId, botTag: client.user!.tag }, "Discord client ready");

// ─── Backfill ─────────────────────────────────────────────────────────────────

let filled = 0;
let notFound = 0;

for (const row of emptyRows) {
    let authorId: string;

    if (row.role === "assistant") {
        authorId = botUserId;
    } else {
        try {
            const channel = await client.channels.fetch(row.channelId);
            if (!channel?.isTextBased()) {
                throw new Error(`Channel ${row.channelId} not found or not text-based`);
            }
            // TYPE COERCION: isTextBased() narrows to TextBasedChannel which has .messages but
            // TypeScript's union doesn't expose it without an explicit cast.
            const discordMsg = await (
                channel as { messages: { fetch: (id: string) => Promise<{ author: { id: string } }> } }
            ).messages.fetch(row.discordMessageId);
            authorId = discordMsg.author.id;
        } catch (err) {
            logger.warn(
                { discordMessageId: row.discordMessageId, channelId: row.channelId, err },
                "Could not fetch Discord message — leaving as ''",
            );
            notFound++;
            continue;
        }
    }

    await db.update(messages).set({ discordAuthorId: authorId }).where(eq(messages.id, row.id));
    filled++;

    if (filled % 100 === 0) {
        logger.info({ filled, total: emptyRows.length }, "Backfill progress");
    }
}

client.destroy();

logger.info({ filled, notFound, total: emptyRows.length }, "Backfill complete");

await db.$client.end();
