ALTER TABLE "gemini_files" DROP COLUMN "source_type";--> statement-breakpoint
ALTER TABLE "gemini_files" DROP COLUMN "discord_attachment_id";--> statement-breakpoint
ALTER TABLE "gemini_files" DROP COLUMN "discord_filename";--> statement-breakpoint
ALTER TABLE "gemini_files" DROP COLUMN "embed_index";--> statement-breakpoint
ALTER TABLE "gemini_files" DROP COLUMN "embed_media_key";--> statement-breakpoint
DROP TYPE "public"."embed_media_key";--> statement-breakpoint
DROP TYPE "public"."gemini_file_source_type";