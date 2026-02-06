CREATE TYPE "public"."role" AS ENUM('user', 'model', 'system');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"role" "role" NOT NULL,
	"content" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"parent_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL
);
