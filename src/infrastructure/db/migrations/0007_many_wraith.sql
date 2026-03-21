CREATE TYPE "public"."embed_media_key" AS ENUM('image', 'video', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."gemini_file_source_type" AS ENUM('attachment', 'embed_media');--> statement-breakpoint
ALTER TABLE "gemini_files" ALTER COLUMN "discord_attachment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gemini_files" ALTER COLUMN "discord_filename" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gemini_files" ADD COLUMN "source_type" "gemini_file_source_type" DEFAULT 'attachment' NOT NULL;--> statement-breakpoint
ALTER TABLE "gemini_files" ADD COLUMN "embed_index" integer;--> statement-breakpoint
ALTER TABLE "gemini_files" ADD COLUMN "embed_media_key" "embed_media_key";