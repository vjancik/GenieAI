import { eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
	IDiscordMessagePageRepository,
	DiscordMessagePage,
} from '../../core/domain/repositories/discord-message-page-repository';
import { discordMessagePages } from './schema';

export class PostgresDiscordMessagePageRepository implements IDiscordMessagePageRepository {
	constructor(private readonly db: NodePgDatabase) {}

	async create(page: Omit<DiscordMessagePage, 'id'>): Promise<string> {
		const [inserted] = await this.db
			.insert(discordMessagePages)
			.values({
				messageId: page.messageId,
				offset: page.offset,
			})
			.returning({ id: discordMessagePages.id });

		if (!inserted) throw new Error('Failed to create discord message page');
		return inserted.id;
	}

	async findById(id: string): Promise<DiscordMessagePage | null> {
		const [page] = await this.db.select().from(discordMessagePages).where(eq(discordMessagePages.id, id));

		if (!page) return null;

		return {
			id: page.id,
			messageId: page.messageId,
			offset: page.offset,
		};
	}

	async delete(id: string): Promise<void> {
		await this.db.delete(discordMessagePages).where(eq(discordMessagePages.id, id));
	}
}
