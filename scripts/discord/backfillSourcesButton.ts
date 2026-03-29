/**
 * Backfills the Sources button onto existing bot response messages.
 *
 * After the Sources button was introduced, all new web-search responses get the
 * button automatically. This script adds it retroactively to messages that were
 * sent before the button existed.
 *
 * For each assistant row in the DB with non-empty langchain_messages:
 *   1. Deserialises the stored LangChain messages and counts grounding chunks on
 *      the last AIMessage.
 *   2. If the count is > 0, fetches the Discord message.
 *   3. If it doesn't already have a Sources button, adds one (preserving all
 *      existing buttons) with the correct count in the label.
 *
 * Run with:
 *   bun scripts/discord/backfillSourcesButton.ts
 *
 * Requires DATABASE_URL and DISCORD_TOKEN (loaded automatically from .env by Bun).
 * Safe to re-run — messages that already have a Sources button are skipped.
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    ComponentType,
    Events,
    GatewayIntentBits,
    type Message,
} from "discord.js";
import { and, eq, gt } from "drizzle-orm";
import pino from "pino";
import { extractWebGroundingChunks } from "../../src/application/formatters/groundingSources.ts";
import { dbMessagesToLangchain } from "../../src/application/helpers/messageTransformers.ts";
import { SOURCES_BUTTON_ID } from "../../src/application/shared/tokens.ts";
import { createDb } from "../../src/infrastructure/db/connection.ts";
import { messages } from "../../src/infrastructure/db/schema.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the number of web grounding chunks on the last message in the array, or 0. */
function countSources(row: { langchainMessages: unknown[] }): number {
    if (row.langchainMessages.length === 0) return 0;
    // dbMessagesToLangchain expects PersistedChatMessage shape; cast via unknown.
    // TYPE COERCION: the DB row shape is structurally compatible with PersistedChatMessage
    // for the fields dbMessagesToLangchain accesses (langchainMessages array).
    const langchainMessages = dbMessagesToLangchain(
        [row] as unknown as Parameters<typeof dbMessagesToLangchain>[0],
        logger,
        false,
    );
    const last = langchainMessages.at(-1);
    if (!last) return 0;
    return extractWebGroundingChunks(last.additional_kwargs ?? {}).length;
}

/** Parses existing buttons from a raw discord.js Message. */
function parseExistingButtons(message: Message): Array<{ customId: string; label: string; style: ButtonStyle }> {
    const buttons: Array<{ customId: string; label: string; style: ButtonStyle }> = [];
    for (const row of message.components) {
        if (row.type !== ComponentType.ActionRow) continue;
        for (const component of row.components) {
            if (component.type !== ComponentType.Button) continue;
            if (!component.customId) continue;
            buttons.push({ customId: component.customId, label: component.label ?? "", style: component.style });
        }
    }
    return buttons;
}

/** Builds an ActionRow from a mixed list of existing + new buttons. */
function buildRow(
    buttons: Array<{ customId: string; label: string; style: ButtonStyle }>,
): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(b.style)),
    );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN env var is required");

const db = createDb(process.env.DATABASE_URL ?? "");

const BATCH_SIZE = 10;

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

// ─── Backfill ─────────────────────────────────────────────────────────────────

let updated = 0;
let alreadyHasButton = 0;
let noSources = 0;
let notFound = 0;
let processed = 0;

// Keyset-paginated cursor over assistant rows, ordered by id ASC.
// id is unique so the cursor always advances — every row is processed exactly once.
// Fetches BATCH_SIZE rows at a time to avoid loading all langchain_messages into memory at once.
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

        const sourceCount = countSources(row);
        if (sourceCount === 0) {
            noSources++;
            continue;
        }

        let discordMessage: Message;
        try {
            const channel = await client.channels.fetch(row.channelId);
            if (!channel?.isTextBased()) {
                logger.warn({ channelId: row.channelId }, "Channel not found or not text-based — skipping");
                notFound++;
                continue;
            }
            // TYPE COERCION: isTextBased() returns TextBasedChannel whose .messages property
            // isn't surfaced by TypeScript's union without an explicit cast.
            discordMessage = await (
                channel as { messages: { fetch: (id: string) => Promise<Message> } }
            ).messages.fetch(row.discordMessageId);
        } catch {
            logger.warn(
                { discordMessageId: row.discordMessageId, channelId: row.channelId },
                "Discord message not found — skipping",
            );
            notFound++;
            continue;
        }

        const existingButtons = parseExistingButtons(discordMessage);

        if (existingButtons.some((b) => b.customId === SOURCES_BUTTON_ID)) {
            alreadyHasButton++;
            logger.info({ discordMessageId: row.discordMessageId }, "Sources button already present — skipping");
            continue;
        }

        const newButtons = [
            ...existingButtons,
            { customId: SOURCES_BUTTON_ID, label: `Sources · ${sourceCount}`, style: ButtonStyle.Secondary },
        ];

        try {
            await discordMessage.edit({ components: [buildRow(newButtons)] });
            updated++;
            logger.info({ discordMessageId: row.discordMessageId, sourceCount }, "Added Sources button");
        } catch (err) {
            logger.warn({ discordMessageId: row.discordMessageId, err }, "Failed to edit Discord message — skipping");
        }
    }
}

client.destroy();
await db.$client.end();

logger.info({ updated, alreadyHasButton, noSources, notFound, processed }, "Done");
