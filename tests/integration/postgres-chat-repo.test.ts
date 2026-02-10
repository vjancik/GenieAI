import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { BaseMessage } from '../../src/core/domain/entities/message';
import { Role } from '../../src/core/domain/value-objects/role';
import { PostgresChatRepository } from '../../src/infrastructure/database/postgres-chat-repo';
import * as schema from '../../src/infrastructure/database/schema';
import { discordMessages, messages } from '../../src/infrastructure/database/schema';

// Use 127.0.0.1 to avoid Windows localhost issues
const connectionString =
	process.env.DATABASE_URL ?? 'postgresql://test_user:test_password@127.0.0.1:5434/genie_ai_test';

describe('PostgresChatRepository Integration', () => {
	let repo: PostgresChatRepository;
	let pool: Pool;
	let db: NodePgDatabase<typeof schema>;

	beforeAll(async () => {
		// Connect to DB using pg Pool
		pool = new Pool({ connectionString });
		db = drizzle(pool, { schema });

		// Wait for DB to be ready
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
		// Clean tables
		await db.delete(discordMessages);
		await db.delete(messages);
	});

	test('should save and retrieve a message', async () => {
		repo = new PostgresChatRepository(db);

		const msgId = crypto.randomUUID();
		const _convId = crypto.randomUUID();

		const msg = new BaseMessage({
			id: msgId,
			role: Role.USER,
			content: 'Hello Integration',
			timestamp: new Date(),
			metadata: { userId: 'user-123' },
		});

		await repo.saveMessage(msg);

		const retrieved = await repo.findById(msg.id);
		expect(retrieved).toBeDefined();
		expect(retrieved?.id).toBe(msg.id);
		expect(retrieved?.content).toBe('Hello Integration');
		expect(retrieved?.metadata?.userId).toBe('user-123');
	});

	test('should retrieve conversation history correctly', async () => {
		repo = new PostgresChatRepository(db);
		const _convId = crypto.randomUUID();

		// Create a thread: User -> AI -> User
		const msg1Id = crypto.randomUUID();
		const msg1 = new BaseMessage({
			id: msg1Id, // Root
			role: Role.USER,
			content: 'Start',
			timestamp: new Date(Date.now() - 10000),
		});

		const msg2Id = crypto.randomUUID();
		const msg2 = new BaseMessage({
			id: msg2Id, // Child of msg-1
			role: Role.ASSISTANT,
			content: 'Reply 1',
			parentId: msg1Id,
			timestamp: new Date(Date.now() - 5000),
		});

		const msg3Id = crypto.randomUUID();
		const msg3 = new BaseMessage({
			id: msg3Id, // Child of msg-2
			role: Role.USER,
			content: 'Reply 2',
			parentId: msg2Id,
			timestamp: new Date(),
		});

		await repo.saveMessage(msg1);
		await repo.saveMessage(msg2);
		await repo.saveMessage(msg3);

		const history = await repo.getHistory(msg2Id);

		expect(history).toHaveLength(2);
		expect(history[0]?.id).toBe(msg1Id);
		expect(history[1]?.id).toBe(msg2Id);
	});
});
