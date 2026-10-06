-- Managed fork: operator opt-in for ambient Telegram group traffic. Idempotent
-- so a later upstream migration renumbering cannot apply it twice.
ALTER TABLE "chat_endpoint_resources" ADD COLUMN IF NOT EXISTS "respond_without_mention" boolean DEFAULT false NOT NULL;
