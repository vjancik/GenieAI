/**
 * BENCHMARK RESULTS SUMMARY
 * -------------------------
 * Observations:
 * 1. Rate Limiting: The Discord API rate limits message sending after 6 messages in quick succession.
 * 2. Recovery: The rate limit window appears to require approximately 5 seconds to reset.
 * 3. Throughput: The effective sustained rate limit is ~1 message per second.
 *
 * Performance Comparison (Best Round-Trip Times):
 * - Raw API: 190ms
 * - Discord.js: 195ms
 *
 * Conclusion:
 * The performance benefit of a custom "Raw" implementation over discord.js is negligible (~5ms).
 * Given the complexity of implementing Gateway reconnection, heartbeat logic, and manual rate limit
 * handling, using a mature library like discord.js is the recommended approach for most use cases.
 */

import { randomUUID } from 'node:crypto';
import { Client, type Message as DiscordMessage, GatewayIntentBits, type TextChannel } from 'discord.js';
import { PinoLogger } from '../infrastructure/logging/pino-logger';

const rootLogger = new PinoLogger('info', 'text');
const logger = rootLogger.child({ serviceName: 'LatencyBenchmark' });

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.BENCHMARK_DISCORD_CHANNEL_ID;
const ITERATIONS = 10;

if (!TOKEN || !CHANNEL_ID) {
	logger.error('Error: DISCORD_TOKEN and BENCHMARK_DISCORD_CHANNEL_ID must be set in .env');
	process.exit(1);
}

// --- Discord.js Setup ---
const djsClient = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

await djsClient.login(TOKEN);
const djsChannel = (await djsClient.channels.fetch(CHANNEL_ID)) as TextChannel;

// --- Raw API Setup ---
class RawDiscordClient {
	private ws: WebSocket | null = null;
	private sequence: number | null = null;
	private resolveMessage: ((msg: unknown) => void) | null = null;
	private pendingKey: string | null = null;

	async connect() {
		return new Promise<void>((resolve, reject) => {
			logger.info('[RawWS] Connecting to Gateway...');
			this.ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

			const timeout = setTimeout(() => {
				reject(new Error('Gateway connection timed out'));
			}, 10000);

			this.ws.onclose = (event) => {
				logger.error(`[RawWS] Closed: ${event.code} ${event.reason}`);
			};

			this.ws.onerror = (event) => {
				logger.error('[RawWS] Error:', event);
			};

			this.ws.onmessage = (event) => {
				const data = JSON.parse(event.data.toString());
				const { op, t, d, s } = data;

				if (s) this.sequence = s;

				switch (op) {
					case 10: {
						// Hello
						clearTimeout(timeout);
						const heartbeatInterval = d.heartbeat_interval;
						logger.info(`[RawWS] Received Hello. Heartbeat interval: ${heartbeatInterval}ms`);
						setInterval(() => {
							this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
						}, heartbeatInterval);

						this.ws?.send(
							JSON.stringify({
								op: 2,
								d: {
									token: TOKEN,
									intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
									properties: { os: 'windows', browser: 'bun', device: 'bun' },
								},
							}),
						);
						break;
					}

					case 0: // Event
						if (t === 'READY') {
							logger.info('[RawWS] Ready!');
							resolve();
						}
						if (t === 'MESSAGE_CREATE') {
							if (this.pendingKey && d.content.includes(this.pendingKey)) {
								this.pendingKey = null;
								this.resolveMessage?.(d);
							}
						}
						break;

					case 1: // Heartbeat Request
						this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
						break;

					case 7: // Reconnect
						logger.warn('[RawWS] Gateway requested reconnect (Op 7)');
						break;

					case 9: // Invalid Session
						logger.warn('[RawWS] Invalid Session (Op 9)');
						break;

					case 11: // Heartbeat ACK
						break;
				}
			};
		});
	}

	async waitForMessage(key: string) {
		this.pendingKey = key;
		return new Promise<unknown>((resolve, reject) => {
			this.resolveMessage = resolve;
			// Timeout if no message received in 15 seconds
			setTimeout(() => {
				if (this.pendingKey === key) {
					this.resolveMessage = null;
					this.pendingKey = null;
					reject(new Error(`Timeout waiting for message with key: ${key}`));
				}
			}, 15000);
		});
	}

	async sendMessage(content: string): Promise<unknown> {
		const url = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`;
		const options = {
			method: 'POST',
			headers: {
				Authorization: `Bot ${TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ content }),
		};

		const res = await fetch(url, options);

		if (res.status === 429) {
			const data = (await res.json()) as { retry_after?: number };
			const retryAfter = (data.retry_after ?? 5) * 1000;
			logger.warn(`\n[RawAPI] Rate limited! (429). Retrying in ${retryAfter}ms...`);
			await new Promise((resolve) => setTimeout(resolve, retryAfter));
			return this.sendMessage(content);
		}

		if (!res.ok) {
			const errorText = await res.text();
			logger.error(`\n[RawAPI] Error ${res.status}: ${errorText}`);
			throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
		}

		return res.json();
	}
}

const rawClient = new RawDiscordClient();
await rawClient.connect();

logger.info('Setup complete. Starting benchmarks...');

// --- Helper for formatting results ---
function printStats(name: string, durations: number[]) {
	const sum = durations.reduce((a, b) => a + b, 0);
	const avg = sum / durations.length;
	const min = Math.min(...durations);
	const max = Math.max(...durations);

	logger.info(`\n--- ${name} ---`);
	logger.info(`Iterations: ${durations.length}`);
	logger.info(`Average:    ${avg.toFixed(2)}ms`);
	logger.info(`Min:        ${min.toFixed(2)}ms`);
	logger.info(`Max:        ${max.toFixed(2)}ms`);
	for (const [i, d] of durations.entries()) {
		logger.info(`  Iter ${i + 1}: ${d.toFixed(2)}ms`);
	}
}

// --- Benchmark Runner ---

async function runBenchmarks() {
	const djsDurations: number[] = [];
	const rawDurations: number[] = [];

	logger.info(`\nRunning Raw API Benchmark (${ITERATIONS} iterations)...`);
	for (let i = 0; i < ITERATIONS; i++) {
		const key = `raw-bench-${randomUUID()}`;
		const waitPromise = rawClient.waitForMessage(key);

		const start = performance.now();
		await rawClient.sendMessage(key);
		await waitPromise;
		const end = performance.now();
		rawDurations.push(end - start);
		process.stdout.write('.'); // Progress indicator
	}
	process.stdout.write('\n');

	logger.info('\nWaiting for rate limits to settle (2s)...');
	await new Promise((resolve) => setTimeout(resolve, 2000));

	logger.info(`\\nRunning Discord.js Benchmark (${ITERATIONS} iterations)...`);
	for (let i = 0; i < ITERATIONS; i++) {
		const key = `djs-bench-${randomUUID()}`;
		const waitPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				djsClient.off('messageCreate', listener);
				reject(new Error(`Timeout waiting for Djs message with key: ${key}`));
			}, 15000);

			const listener = (msg: DiscordMessage) => {
				if (msg.content === key) {
					clearTimeout(timeout);
					djsClient.off('messageCreate', listener);
					resolve();
				}
			};
			djsClient.on('messageCreate', listener);
		});

		const start = performance.now();
		await djsChannel.send(key);
		await waitPromise;
		const end = performance.now();
		djsDurations.push(end - start);
		process.stdout.write('.'); // Progress indicator
	}
	process.stdout.write('\n');

	printStats('Raw API Latency', rawDurations);
	printStats('Discord.js Latency', djsDurations);
}

await runBenchmarks();

// Cleanup
djsClient.destroy();
process.exit(0);
