ALTER TABLE "agents" ADD COLUMN "adapter_config_archive" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "fallback_adapter_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "fallback_state" jsonb;
