-- Add first_page_discord_message_id column (FK → messages, non-unique).
-- Drop the old FK on bot_discord_message_id (it was pointing to the current page message;
-- now only first_page_discord_message_id carries the FK so subsequent pages can reference
-- the first page's messages row without needing their own messages row to exist first).
-- bot_discord_message_id retains its UNIQUE constraint for lookup by current message ID.

ALTER TABLE "message_pages" DROP CONSTRAINT "message_pages_bot_discord_message_id_messages_discord_message_id_fk";
--> statement-breakpoint
ALTER TABLE "message_pages" ADD COLUMN "first_page_discord_message_id" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "message_pages" ADD CONSTRAINT "message_pages_first_page_discord_message_id_messages_discord_message_id_fk" FOREIGN KEY ("first_page_discord_message_id") REFERENCES "public"."messages"("discord_message_id") ON DELETE cascade ON UPDATE no action;
