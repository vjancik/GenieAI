CREATE TYPE "public"."message_interaction_type" AS ENUM('message_create', 'summary_command');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "interaction_type" "message_interaction_type" DEFAULT 'message_create';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "interaction_author_discord_id" text;