import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { discordMessages } from './schema';
import type { IDiscordRepository } from '../../core/domain/repositories/discord-repository';
import { DatabaseError } from '../../core/domain/errors/application-error';

export class PostgresDiscordRepository implements IDiscordRepository {
    constructor(private readonly db: NodePgDatabase<any>) { }

    async saveMapping(discordId: string, messageId: string): Promise<void> {
        try {
            await this.db.insert(discordMessages).values({
                id: discordId,
                messageId: messageId,
            }).onConflictDoNothing();
        } catch (error) {
            throw new DatabaseError('Failed to save Discord-to-Internal message mapping', error);
        }
    }

    async getMessageId(discordId: string): Promise<string | null> {
        try {
            const [result] = await this.db.select({ messageId: discordMessages.messageId })
                .from(discordMessages)
                .where(eq(discordMessages.id, discordId));

            return result?.messageId || null;
        } catch (error) {
            throw new DatabaseError('Failed to retrieve internal ID for Discord message', error);
        }
    }
}
