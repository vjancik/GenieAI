import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from '../../config/env';

/**
 * Dehydrates a Discord.js object (or any complex object) into a serializable plain object.
 * It recursively handles Collections, Maps, Sets, and objects with toJSON methods.
 */
function dehydrate(
	val: unknown,
	options: { key?: string; seen?: WeakMap<object, string>; verbose?: boolean } = {},
): unknown {
	const { key = 'root', seen = new WeakMap<object, string>(), verbose = false } = options;
	const type = typeof val;

	if (val === null || type !== 'object') {
		if (type === 'bigint') {
			if (verbose) console.log(`[DEHYDRATE] BigInt at ${key}`);
			return (val as bigint).toString();
		}
		if (verbose) console.log(`[DEHYDRATE] Primitive (${type}) at ${key}`);
		return val;
	}

	const seenKey = seen.get(val as object);
	if (seenKey) {
		if (verbose) console.log(`[DEHYDRATE] Circular at ${key} (first seen at ${seenKey})`);
		return `[Circular - ${seenKey}]`;
	}
	seen.set(val as object, key);

	const obj = val as Record<string, unknown>;
	const constructorName = obj.constructor?.name || 'Object';

	// 1. Prioritize Collections/Maps (Discord primary targets)
	if (typeof obj.map === 'function' && typeof obj.size === 'number') {
		if (verbose) console.log(`[DEHYDRATE] [COLLECTION] (${constructorName}) at ${key}, size: ${obj.size}`);
		return (obj as { map: (fn: (item: unknown, idx: string | number) => unknown) => unknown[] }).map(
			(item: unknown, idx: string | number) => dehydrate(item, { key: `${key}[${idx}]`, seen, verbose }),
		);
	}

	// 2. Standard Set-like expansion
	if (typeof obj.values === 'function' && typeof obj.size === 'number') {
		if (verbose) console.log(`[DEHYDRATE] [SET] (${constructorName}) at ${key}, size: ${obj.size}`);
		return Array.from((obj as { values: () => IterableIterator<unknown> }).values()).map((item, idx) =>
			dehydrate(item, { key: `${key}[${idx}]`, seen, verbose }),
		);
	}

	// 3. Handle models with toJSON, but intercept their keys to recover live properties
	if (typeof obj.toJSON === 'function') {
		if (verbose) console.log(`[DEHYDRATE] [TO_JSON] Calling toJSON on ${constructorName} at ${key}`);
		const json = (obj as { toJSON: () => unknown }).toJSON();

		if (json === null || typeof json !== 'object') {
			if (verbose) console.log(`[DEHYDRATE] toJSON returned primitive at ${key}`);
			return json;
		}

		const result: Record<string, unknown> = {};
		for (const k in json) {
			if (Object.hasOwn(json, k)) {
				const sourceVal = obj[k] !== undefined ? obj[k] : (json as Record<string, unknown>)[k];

				if (verbose && obj[k] !== undefined && sourceVal !== (json as Record<string, unknown>)[k]) {
					console.log(`[DEHYDRATE] [RECOVERED] Live property: ${k} at ${key}`);
				}

				result[k] = dehydrate(sourceVal, { key: `${key}.${k}`, seen, verbose });
			}
		}
		return result;
	}

	// 4. Standard Arrays
	if (Array.isArray(obj)) {
		if (verbose) console.log(`[DEHYDRATE] [ARRAY] length: ${obj.length} at ${key}`);
		return obj.map((item: unknown, idx: number) => dehydrate(item, { key: `${key}[${idx}]`, seen, verbose }));
	}

	// 5. Fallback: Generic Object iteration
	if (verbose) console.log(`[DEHYDRATE] [OBJECT] (${constructorName}) at ${key}`);
	const result: Record<string, unknown> = {};
	for (const k in obj) {
		if (Object.hasOwn(obj, k)) {
			result[k] = dehydrate(obj[k], { key: `${key}.${k}`, seen, verbose });
		}
	}
	return result;
}

/**
 * Standalone development script to monitor and log all Discord messages.
 * This is useful for debugging what the bot actually "sees" and verifying content/intents.
 */
async function monitor() {
	if (!config.discord.token) {
		console.error('Error: DISCORD_TOKEN is not defined in the environment.');
		process.exit(1);
	}

	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
	});

	client.once(Events.ClientReady, async (c) => {
		console.log(`[MONITOR] Ready! Logged in as ${c.user.tag}`);
		console.log('[MONITOR] Listening for messages...');

		// Demonstrate and assert bot role retrieval
		for (const guild of c.guilds.cache.values()) {
			const method1 = guild.members.me?.roles.botRole;
			const method2 = guild.roles.botRoleFor(c.user);

			console.log(`\n[ROLE CHECK] Guild: ${guild.name}`);
			console.log(`  Method 1 (members.me.roles.botRole): ${method1?.name} (${method1?.id})`);
			console.log(`  Method 2 (roles.botRoleFor):         ${method2?.name} (${method2?.id})`);

			if (method1?.id === method2?.id) {
				console.log('  ✅ Assertion Passed: Both methods return the same role ID.');
			} else {
				console.error('  ❌ Assertion Failed: Role IDs do not match or are missing.');
			}
		}
	});

	client.on(Events.MessageCreate, (message) => {
		// Ignore bot messages to avoid noise
		if (message.author.bot) return;

		const timestamp = new Date().toISOString();
		const channelName = 'name' in message.channel ? message.channel.name : 'DM';
		const guildName = message.guild?.name ?? 'Direct Message';

		console.log(`\n--- Message Received [${timestamp}] ---`);
		console.log(`Guild:   ${guildName}`);
		console.log(`Channel: ${channelName} (${message.channelId})`);
		console.log(`Author:  ${message.author.tag} (${message.author.id})`);
		console.log(`Content: "${message.content}"`);

		if (message.attachments.size > 0) {
			console.log(`Attachments: ${message.attachments.map((a) => a.url).join(', ')}`);
		}

		if (message.reference) {
			console.log(`Reference: Message ID ${message.reference.messageId}`);
		}
		console.log('----------------------------------------');

		const timestampSlug = new Date().toISOString().replace(/[:.]/g, '-');
		const filename = `message-${timestampSlug}-${message.id}.json`;
		const messagesDir = path.join(import.meta.dir, 'messages');
		const filePath = path.join(messagesDir, filename);

		if (!fs.existsSync(messagesDir)) {
			fs.mkdirSync(messagesDir, { recursive: true });
		}

		try {
			// Call dehydrate with verbose logging enabled for debugging (set to false to silence)
			const data = dehydrate(message, { verbose: true });
			const serialized = JSON.stringify(data, null, 2);
			fs.writeFileSync(filePath, serialized);
			console.log(`[MONITOR] Saved full message object to: ${filename}`);
		} catch (err) {
			console.error(`[MONITOR] Failed to save message object: ${err}`);
		}
	});

	try {
		await client.login(config.discord.token);
	} catch (error) {
		console.error('[MONITOR] Failed to login to Discord:', error);
		process.exit(1);
	}
}

monitor().catch((err) => {
	console.error('[MONITOR] Unexpected error:', err);
	process.exit(1);
});
