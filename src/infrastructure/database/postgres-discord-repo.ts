import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { discordMessages } from './schema';
import type { IDiscordRepository } from '../../core/domain/repositories/discord-repository';

export class PostgresDiscordRepository implements IDiscordRepository {
    constructor(private readonly db: NodePgDatabase<any>) { }

    async saveMapping(discordId: string, messageId: string): Promise<void> {
        await this.db.insert(discordMessages).values({
            id: discordId,
            messageId: messageId,
        }).onConflictDoNothing();
    }

    async getMessageId(discordId: string): Promise<string | null> {
        const [result] = await this.db.select({ messageId: discordMessages.messageId })
            .from(discordMessages)
            .where(eq(discordMessages.id, discordId));

        return result?.messageId || null;
    }
}
