import { Client, Events, GatewayIntentBits, MessageFlags, TextDisplayBuilder } from 'discord.js';
import { config } from '../../config/env';

/**
 * Dev script to test the new TextDisplayComponent API.
 * Purpose: Verify if TextDisplayComponent can bypass the 2000 character limit.
 * Result: It does, but I won't be using it because the text doesn't get indexed and isn't searchable.
 */
async function testTextDisplay() {
	if (!config.discord.token) {
		console.error('Error: DISCORD_TOKEN is not defined in the environment.');
		process.exit(1);
	}

	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
	});

	client.once(Events.ClientReady, (c) => {
		console.log(`[TEST-DISPLAY] Ready! Logged in as ${c.user.tag}`);
		console.log('[TEST-DISPLAY] Listening for "!testmessage" command...');
	});

	client.on(Events.MessageCreate, async (message) => {
		// Ignore bot messages
		if (message.author.bot) return;

		if (message.content.trim() === '!testmessage') {
			console.log(`[TEST-DISPLAY] Received command from ${message.author.tag}`);

			// Create a 4000 character sample message
			const baseText = 'TextDisplayComponent Test - This is a long block of text intended to verify character limits. ';
			let longText = '';
			while (longText.length < 4000) {
				longText += baseText;
			}
			longText = longText.substring(0, 4000);

			console.log(`[TEST-DISPLAY] Prepared message length: ${longText.length} characters`);

			try {
				// Use the new TextDisplayBuilder
				const textDisplay = new TextDisplayBuilder({ content: longText });

				console.log('[TEST-DISPLAY] Attempting to send message with TextDisplayComponent...');

				// TextDisplayComponent is a top-level component, so it goes directly into components array
				// Note: According to Discord API, some components might require specific container structures
				// but TextDisplay is documented as a top-level component in some contexts.
				await message.reply({
					flags: MessageFlags.IsComponentsV2,
					components: [textDisplay],
				});

				console.log('[TEST-DISPLAY] ✅ Message sent successfully!');
			} catch (error) {
				console.error('[TEST-DISPLAY] ❌ Failed to send message:', error);

				if (error instanceof Error) {
					console.error(`Error details: ${error.message}`);
				}
			}
		}
	});

	try {
		await client.login(config.discord.token);
	} catch (error) {
		console.error('[TEST-DISPLAY] Failed to login to Discord:', error);
		process.exit(1);
	}
}

testTextDisplay().catch((err) => {
	console.error('[TEST-DISPLAY] Unexpected error:', err);
	process.exit(1);
});
