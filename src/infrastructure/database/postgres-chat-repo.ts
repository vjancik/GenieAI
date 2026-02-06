import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc, sql } from 'drizzle-orm';
import type { IChatRepository } from '../../core/domain/repositories/chat-repository';
import { Message, type MessageAttachment } from '../../core/domain/entities/message';
import { messages } from './schema';
import { Role } from '../../core/domain/value-objects/role';

export class PostgresChatRepository implements IChatRepository {
    constructor(private readonly db: NodePgDatabase<any>) { }

    async saveMessage(message: Message): Promise<void> {
        await this.db.insert(messages).values({
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
        /**
         * We use a Recursive Common Table Expression (CTE) to fetch the message chain.
         * 1. Start with the given messageId.
         * 2. Recursively find the parent of each message.
         * 3. Stop when no parentId exists or limit reached.
         * This executes as ONE single database request.
         */
        const historyCte = this.db.$with('history').as(
            this.db.select({
                id: messages.id,
                role: messages.role,
                content: messages.content,
                timestamp: messages.timestamp,
                metadata: messages.metadata,
                parentId: messages.parentId,
                attachments: messages.attachments,
                level: sql<number>`1`.as('level'),
            })
                .from(messages)
                .where(eq(messages.id, messageId))
                .unionAll(
                    this.db.select({
                        id: messages.id,
                        role: messages.role,
                        content: messages.content,
                        timestamp: messages.timestamp,
                        metadata: messages.metadata,
                        parentId: messages.parentId,
                        attachments: messages.attachments,
                        level: sql<number>`level + 1`,
                    })
                        .from(messages)
                        .innerJoin(sql`history`, eq(messages.id, sql`history.parent_id`))
                        .where(sql`level < ${limit}`)
                )
        );

        const results = await this.db
            .with(historyCte)
            .select()
            .from(historyCte)
            .orderBy(desc(sql`timestamp`));

        return results.reverse().map(r => new Message({
            id: r.id,
            role: r.role as Role,
            content: r.content,
            timestamp: r.timestamp,
            metadata: r.metadata || undefined,
            parentId: r.parentId || undefined,
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
