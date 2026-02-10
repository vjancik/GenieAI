import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from '../config/env';

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
