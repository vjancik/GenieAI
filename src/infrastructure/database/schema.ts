import { pgTable, text, timestamp, jsonb, uuid, pgEnum, integer } from 'drizzle-orm/pg-core';
import { Role } from '../../core/domain/value-objects/role';

export const roleEnum = pgEnum('role', [Role.USER, Role.ASSISTANT, Role.SYSTEM]);

export const messages = pgTable('messages', {
    id: uuid('id').primaryKey(),
    role: roleEnum('role').notNull(),
    content: text('content').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, any>>(),
    parentId: uuid('parent_id'),
    attachments: jsonb('attachments').$type<any[]>().default([]).notNull(),
});

export const discordMessages = pgTable('discord_messages', {
    id: text('id').primaryKey(), // Discord Snowflake
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
});

export const discordMessagePages = pgTable('discord_message_pages', {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    offset: integer('offset').notNull(),
});
