CREATE TABLE "gemini_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"api_key" text NOT NULL,
	"is_paid" boolean NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gemini_api_keys_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE "gemini_file_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"gemini_file_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"gemini_file_name" text NOT NULL,
	"gemini_url" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gemini_file_uploads_gemini_file_name_unique" UNIQUE("gemini_file_name")
);
--> statement-breakpoint
CREATE TABLE "gemini_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"original_gemini_url" text NOT NULL,
	"discord_attachment_id" text NOT NULL,
	"discord_filename" text NOT NULL,
	"message_id" uuid NOT NULL,
	"discord_message_id" text NOT NULL,
	CONSTRAINT "gemini_files_original_gemini_url_unique" UNIQUE("original_gemini_url")
);
--> statement-breakpoint
CREATE TABLE "message_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bot_discord_message_id" text NOT NULL,
	"first_page_message_id" uuid NOT NULL,
	"end_offset" integer NOT NULL,
	"current_page" integer NOT NULL,
	"total_pages" integer NOT NULL,
	"ended_in_code_block" boolean DEFAULT false NOT NULL,
	"code_block_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_pages_bot_discord_message_id_unique" UNIQUE("bot_discord_message_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"discord_message_id" text NOT NULL,
	"replies_to_discord_id" text,
	"channel_id" text NOT NULL,
	"guild_id" text,
	"role" text NOT NULL,
	"langchain_messages" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gemini_file_uploads" ADD CONSTRAINT "gemini_file_uploads_gemini_file_id_gemini_files_id_fk" FOREIGN KEY ("gemini_file_id") REFERENCES "public"."gemini_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gemini_file_uploads" ADD CONSTRAINT "gemini_file_uploads_api_key_id_gemini_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."gemini_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gemini_files" ADD CONSTRAINT "gemini_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_pages" ADD CONSTRAINT "message_pages_first_page_message_id_messages_id_fk" FOREIGN KEY ("first_page_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gemini_file_uploads_file_key_idx" ON "gemini_file_uploads" USING btree ("gemini_file_id","api_key_id");--> statement-breakpoint
CREATE INDEX "gemini_file_uploads_uploaded_at_idx" ON "gemini_file_uploads" USING btree ("uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_guild_channel_discord_id_idx" ON "messages" USING btree ("guild_id","channel_id","discord_message_id");