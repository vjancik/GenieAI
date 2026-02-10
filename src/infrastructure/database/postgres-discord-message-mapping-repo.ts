import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseError } from '../../core/domain/errors/application-error';
import type { IDiscordMessageMappingRepository } from '../../core/domain/repositories/discord-message-mapping-repository';
import type * as schema from './schema';
import { discordMessages } from './schema';

export class PostgresDiscordMessageMappingRepository implements IDiscordMessageMappingRepository {
	constructor(private readonly db: NodePgDatabase<typeof schema>) {}

	async saveMapping(discordId: string, messageId: string): Promise<void> {
		try {
			await this.db
				.insert(discordMessages)
				.values({
					id: discordId,
					messageId: messageId,
				})
				.onConflictDoNothing();
		} catch (error) {
			throw new DatabaseError('Failed to save Discord-to-Internal message mapping', error);
		}
	}

	async getMessageId(discordId: string): Promise<string | null> {
		try {
			const [result] = await this.db
				.select({ messageId: discordMessages.messageId })
				.from(discordMessages)
				.where(eq(discordMessages.id, discordId));

			return result?.messageId ?? null;
		} catch (error) {
			throw new DatabaseError('Failed to retrieve internal ID for Discord message', error);
		}
	}
}
