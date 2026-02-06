CREATE TABLE "discord_message_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"offset" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_message_pages" ADD CONSTRAINT "discord_message_pages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;