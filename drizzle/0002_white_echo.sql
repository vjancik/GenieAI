CREATE TYPE "public"."message_source" AS ENUM('discord', 'web');--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'function';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source" "message_source" DEFAULT 'discord' NOT NULL;