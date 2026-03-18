ALTER TABLE "gemini_files" DROP COLUMN "discord_message_id";
--> statement-breakpoint
ALTER TABLE "gemini_files" DROP COLUMN IF EXISTS "discord_channel_id";