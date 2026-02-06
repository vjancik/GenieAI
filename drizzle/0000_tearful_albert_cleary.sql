CREATE TYPE "public"."role" AS ENUM('user', 'model', 'system');--> statement-breakpoint
CREATE TABLE "discord_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" "role" NOT NULL,
	"content" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"parent_id" uuid,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_messages" ADD CONSTRAINT "discord_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;