ALTER TABLE "message_pages" ADD COLUMN "ended_in_code_block" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_pages" ADD COLUMN "code_block_type" text;