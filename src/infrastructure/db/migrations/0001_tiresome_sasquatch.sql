CREATE TABLE "gemini_file_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_gemini_url" text NOT NULL,
	"gemini_file_name" text NOT NULL,
	"gemini_url" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"discord_attachment_id" text NOT NULL,
	"discord_filename" text NOT NULL,
	"message_discord_id" text NOT NULL,
	CONSTRAINT "gemini_file_uploads_original_gemini_url_unique" UNIQUE("original_gemini_url"),
	CONSTRAINT "gemini_file_uploads_gemini_file_name_unique" UNIQUE("gemini_file_name")
);
--> statement-breakpoint
ALTER TABLE "gemini_file_uploads" ADD CONSTRAINT "gemini_file_uploads_message_discord_id_messages_discord_message_id_fk" FOREIGN KEY ("message_discord_id") REFERENCES "public"."messages"("discord_message_id") ON DELETE cascade ON UPDATE no action;