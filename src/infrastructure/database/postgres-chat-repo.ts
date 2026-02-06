import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc, sql } from 'drizzle-orm';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';
import { messages, discordMessages } from './schema';
import { Role } from '../../core/domain/value-objects/role';

export class PostgresChatRepository implements IChatRepository {
    constructor(private readonly db: NodePgDatabase<any>) { }

    async saveMessage(message: Message, externalId?: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.insert(messages).values({
                id: message.id,
                role: message.role as any,
                content: message.content,
                timestamp: message.timestamp,
                metadata: message.metadata,
                parentId: message.parentId,
                attachments: message.attachments,
            }).onConflictDoUpdate({
                target: [messages.id],
                set: {
                    role: message.role as any,
                    content: message.content,
                    timestamp: message.timestamp,
                    metadata: message.metadata,
                    parentId: message.parentId,
                    attachments: message.attachments,
                }
            });

            if (externalId) {
                await tx.insert(discordMessages).values({
                    id: externalId,
                    messageId: message.id,
                }).onConflictDoNothing();
            }
        });
    }

    async updateMessage(message: Message): Promise<void> {
        await this.db.update(messages)
            .set({
                content: message.content,
                metadata: message.metadata,
                attachments: message.attachments,
            })
            .where(eq(messages.id, message.id));
    }

    async updateAttachment(messageId: string, attachmentId: string, attachment: Partial<MessageAttachment>): Promise<void> {
        const msg = await this.getMessage(messageId);
        if (!msg) return;

        const updatedAttachments = msg.attachments.map(attr =>
            attr.id === attachmentId ? { ...attr, ...attachment } : attr
        );

        await this.db.update(messages)
            .set({ attachments: updatedAttachments })
            .where(eq(messages.id, messageId));
    }

    async getHistory(messageId: string, limit: number = 50): Promise<Message[]> {
        const results = await this.db.execute(sql`
            WITH RECURSIVE history AS (
                SELECT 
                    id, role, content, timestamp, metadata, parent_id, attachments, 1 as level
                FROM messages
                WHERE id = ${messageId}
                UNION ALL
                SELECT 
                    m.id, m.role, m.content, m.timestamp, m.metadata, m.parent_id, m.attachments, h.level + 1
                FROM messages m
                INNER JOIN history h ON m.id = h.parent_id
                WHERE h.level < ${limit}
            )
            SELECT * FROM history ORDER BY timestamp DESC
        `);

        return (results.rows as any[]).reverse().map(r => new Message({
            id: r.id,
            role: r.role as Role,
            content: r.content,
            timestamp: new Date(r.timestamp),
            metadata: r.metadata || undefined,
            parentId: r.parent_id || undefined,
            attachments: r.attachments as any,
        }));
    }

    async getMessage(id: string): Promise<Message | null> {
        const [result] = await this.db.select()
            .from(messages)
            .where(eq(messages.id, id));

        if (!result) return null;

        return new Message({
            id: result.id,
            role: result.role as Role,
            content: result.content,
            timestamp: result.timestamp,
            metadata: result.metadata || undefined,
            parentId: result.parentId || undefined,
            attachments: result.attachments as any,
        });
    }
}
