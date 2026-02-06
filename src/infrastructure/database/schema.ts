import { pgTable, text, timestamp, jsonb, uuid, pgEnum } from 'drizzle-orm/pg-core';
import { Role } from '../../core/domain/value-objects/role';

export const roleEnum = pgEnum('role', [Role.USER, Role.ASSISTANT, Role.SYSTEM]);

export const messages = pgTable('messages', {
    id: text('id').primaryKey(), // Using text to support both UUIDs and Discord snowflaks
    role: roleEnum('role').notNull(),
    content: text('content').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, any>>(),
    parentId: text('parent_id'),
    attachments: jsonb('attachments').$type<any[]>().default([]).notNull(),
});
