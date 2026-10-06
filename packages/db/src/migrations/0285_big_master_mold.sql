-- Managed fork: Telegram forum-topic scope for ambient intake and the per-run
-- tool activity message. Idempotent so a later upstream migration renumbering
-- cannot apply it twice.
ALTER TABLE "chat_endpoint_resources" ADD COLUMN IF NOT EXISTS "respond_without_mention_thread_ids" text[];--> statement-breakpoint
ALTER TABLE "chat_endpoint_resources" ADD COLUMN IF NOT EXISTS "show_tool_activity" boolean DEFAULT false NOT NULL;
