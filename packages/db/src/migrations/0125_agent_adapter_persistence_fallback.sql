ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "adapter_config_archive" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "fallback_adapter_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "fallback_state" jsonb;
