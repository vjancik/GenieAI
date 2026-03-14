CREATE TABLE "message_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bot_discord_message_id" text NOT NULL,
	"end_offset" integer NOT NULL,
	"current_page" integer NOT NULL,
	"total_pages" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_pages_bot_discord_message_id_unique" UNIQUE("bot_discord_message_id")
);
--> statement-breakpoint
ALTER TABLE "message_pages" ADD CONSTRAINT "message_pages_bot_discord_message_id_messages_discord_message_id_fk" FOREIGN KEY ("bot_discord_message_id") REFERENCES "public"."messages"("discord_message_id") ON DELETE cascade ON UPDATE no action;