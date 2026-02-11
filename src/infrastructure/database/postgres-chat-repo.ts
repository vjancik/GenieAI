import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
	BaseAttachment,
	Message,
	type MessageAttachment,
	type MessageAttachmentData,
	type MessageSource,
} from '../../core/domain/entities/message';
import { DatabaseError } from '../../core/domain/errors/application-error';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import type { Role } from '../../core/domain/value-objects/role';
import type * as schema from './schema';
import { discordMessages, messages } from './schema';

interface MessageRow {
	id: string;
	role: Role;
	content: string;
	timestamp: string | number | Date;
	metadata: Record<string, unknown> | null;
	parent_id: string | null;
	attachments: MessageAttachmentData[];
	source: MessageSource;
	[key: string]: unknown;
}

export class PostgresChatRepository implements IChatRepository {
	constructor(private readonly db: NodePgDatabase<typeof schema>) {}

	async saveMessage(message: Message, externalId?: string): Promise<void> {
		try {
			await this.db.transaction(async (tx) => {
				await tx
					.insert(messages)
					.values({
						id: message.id,
						role: message.role,
						content: message.content,
						timestamp: message.timestamp,
						metadata: message.metadata,
						parentId: message.parentId,
						attachments: message.attachments,
						source: message.source,
					})
					.onConflictDoUpdate({
						target: [messages.id],
						set: {
							role: message.role,
							content: message.content,
							timestamp: message.timestamp,
							metadata: message.metadata,
							parentId: message.parentId,
							attachments: message.attachments,
							source: message.source,
						},
					});

				if (externalId) {
					await tx
						.insert(discordMessages)
						.values({
							id: externalId,
							messageId: message.id,
						})
						.onConflictDoNothing();
				}
			});
		} catch (error) {
			throw new DatabaseError('Failed to save message to database', error);
		}
	}

	async updateMessage(message: Message): Promise<void> {
		try {
			await this.db
				.update(messages)
				.set({
					content: message.content,
					metadata: message.metadata,
					attachments: message.attachments,
				})
				.where(eq(messages.id, message.id));
		} catch (error) {
			throw new DatabaseError('Failed to update message in database', error);
		}
	}

	async updateAttachment(
		messageId: string,
		attachmentId: string,
		attachment: Partial<MessageAttachment>,
	): Promise<void> {
		try {
			const msg = await this.findById(messageId);
			if (!msg) return;

			const updatedAttachments = msg.attachments.map((attr) =>
				attr.id === attachmentId ? { ...attr, ...attachment } : attr,
			);

			await this.db.update(messages).set({ attachments: updatedAttachments }).where(eq(messages.id, messageId));
		} catch (error) {
			throw new DatabaseError('Failed to update attachment in database', error);
		}
	}

	async getHistory(messageId: string, limit: number = 100): Promise<Message[]> {
		try {
			const results = await this.db.execute<MessageRow>(sql`
                WITH RECURSIVE history AS (
                    SELECT 
                        id, role, content, timestamp, metadata, parent_id, attachments, source, 1 as level
                    FROM messages
                    WHERE id = ${messageId}
                    UNION ALL
                    SELECT 
                        m.id, m.role, m.content, m.timestamp, m.metadata, m.parent_id, m.attachments, m.source, h.level + 1
                    FROM messages m
                    INNER JOIN history h ON m.id = h.parent_id
                    WHERE h.level < ${limit}
                )
                SELECT * FROM history ORDER BY timestamp DESC
            `);

			return results.rows.reverse().map((r) =>
				Message.create({
					id: r.id,
					role: r.role,
					content: r.content,
					timestamp: new Date(r.timestamp),
					metadata: r.metadata ?? undefined,
					parentId: r.parent_id ?? undefined,
					attachments: (r.attachments ?? []).map((a) => new BaseAttachment(a)),
					source: r.source,
				}),
			);
		} catch (error) {
			throw new DatabaseError('Failed to fetch conversation history', error);
		}
	}

	async findById(id: string): Promise<Message | null> {
		try {
			const [result] = await this.db.select().from(messages).where(eq(messages.id, id));

			if (!result) return null;

			return Message.create({
				id: result.id,
				role: result.role,
				content: result.content,
				timestamp: result.timestamp,
				metadata: result.metadata ?? undefined,
				parentId: result.parentId ?? undefined,
				attachments: (result.attachments ?? []).map((a) => new BaseAttachment(a)),
				source: result.source,
			});
		} catch (error) {
			throw new DatabaseError('Failed to retrieve message from database', error);
		}
	}
}
