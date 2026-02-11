import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Message, MessageAttachmentData } from '../../core/domain/entities/message';
import { MessageSource } from '../../core/domain/entities/message';
import { Role } from '../../core/domain/value-objects/role';

export const roleEnum = pgEnum('role', [Role.USER, Role.ASSISTANT, Role.SYSTEM, Role.FUNCTION]);
export const messageSourceEnum = pgEnum('message_source', [MessageSource.DISCORD, MessageSource.WEB]);

export const messages = pgTable('messages', {
	id: uuid('id').primaryKey(),
	role: roleEnum('role').$type<Role>().notNull(),
	content: text('content').notNull(),
	timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
	metadata: jsonb('metadata').$type<Message['metadata']>(),
	parentId: uuid('parent_id'),
	attachments: jsonb('attachments').$type<MessageAttachmentData[]>().default([]).notNull(),
	source: messageSourceEnum('source').$type<MessageSource>().default(MessageSource.DISCORD).notNull(),
});

export const discordMessages = pgTable('discord_messages', {
	id: text('id').primaryKey(), // Discord Snowflake
	messageId: uuid('message_id')
		.notNull()
		.references(() => messages.id, { onDelete: 'cascade' }),
});

export const discordMessagePages = pgTable('discord_message_pages', {
	id: uuid('id').primaryKey().defaultRandom(),
	messageId: uuid('message_id')
		.notNull()
		.references(() => messages.id, { onDelete: 'cascade' }),
	offset: integer('offset').notNull(),
});
