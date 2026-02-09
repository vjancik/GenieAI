import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PostgresChatRepository } from '../../src/infrastructure/database/postgres-chat-repo'; // Helper to create message
import { PostgresDiscordMessageMappingRepository } from '../../src/infrastructure/database/postgres-discord-message-mapping-repo';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { messages, discordMessages } from '../../src/infrastructure/database/schema';
import { Message } from '../../src/core/domain/entities/message';
import { Role } from '../../src/core/domain/value-objects/role';
import { join } from 'path';

// Use 127.0.0.1 to avoid Windows localhost issues
const connectionString =
	process.env.DATABASE_URL || 'postgresql://test_user:test_password@127.0.0.1:5434/genie_ai_test';

describe('PostgresDiscordMessageMappingRepository Integration', () => {
	let mappingRepo: PostgresDiscordMessageMappingRepository;
	let chatRepo: PostgresChatRepository;
	let pool: Pool;
	let db: ReturnType<typeof drizzle>;

	beforeAll(async () => {
		pool = new Pool({ connectionString });
		db = drizzle(pool);

		// Wait for DB
		await waitForDb(pool);

		// Run migrations
		await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });
	});

	async function waitForDb(pool: Pool, retries = 10, delay = 1000) {
		for (let i = 0; i < retries; i++) {
			try {
				const client = await pool.connect();
				client.release();
				console.log('Database connected successfully.');
				return;
			} catch (err) {
				console.log(`Waiting for database... (${i + 1}/${retries}) Error: ${(err as Error).message}`);
				await new Promise((res) => setTimeout(res, delay));
			}
		}
		throw new Error('Database not ready after retries');
	}

	afterAll(async () => {
		await pool.end();
	});

	beforeEach(async () => {
		await db.delete(discordMessages);
		await db.delete(messages);
	});

	test('should save and retrieve a mapping', async () => {
		chatRepo = new PostgresChatRepository(db);
		mappingRepo = new PostgresDiscordMessageMappingRepository(db);

		// 1. Create a message first (FK constraint)
		const msgId = crypto.randomUUID();
		const msg = new Message({
			id: msgId,
			role: Role.ASSISTANT,
			content: 'Test Content',
			timestamp: new Date(),
		});
		await chatRepo.saveMessage(msg);

		// 2. Save mapping
		const discordId = 'discord-msg-123';
		await mappingRepo.saveMapping(discordId, msgId);

		// 3. Retrieve
		const retrievedInternalId = await mappingRepo.getMessageId(discordId);
		expect(retrievedInternalId).toBe(msgId);
	});

	test('should return null for non-existent mapping', async () => {
		mappingRepo = new PostgresDiscordMessageMappingRepository(db);
		const result = await mappingRepo.getMessageId('non-existent-id');
		expect(result).toBeNull();
	});
});
