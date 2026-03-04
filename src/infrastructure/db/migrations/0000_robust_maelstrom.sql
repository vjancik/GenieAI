CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_message_id" text NOT NULL,
	"replies_to_discord_id" text,
	"channel_id" text NOT NULL,
	"guild_id" text,
	"role" text NOT NULL,
	"content_chunks" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messages_discord_message_id_unique" UNIQUE("discord_message_id")
);
