ALTER TABLE "messages" ADD COLUMN "discord_author_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "used_fallback" boolean;