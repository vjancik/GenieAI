ALTER TABLE "gemini_api_keys" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "gemini_file_uploads" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "gemini_files" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "id" SET DEFAULT uuidv7();