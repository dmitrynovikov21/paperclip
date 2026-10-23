CREATE TABLE "provider_state_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"current_lease_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "provider_state_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "provider_state_generation" integer;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "task_scope_id" uuid;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_adapter_type" text;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_status" text;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_ref" uuid;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_driver_id" text;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_driver_revision" text;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_configuration_digest" text;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_hard_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_cleanup_claim" uuid;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "provider_state_cleanup_claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_provider_state_lease_id_environment_leases_id_fk" FOREIGN KEY ("provider_state_lease_id") REFERENCES "public"."environment_leases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_leases_provider_state_scope_idx" ON "environment_leases" USING btree ("company_id","provider_state_agent_id","provider_state_adapter_type","task_scope_id");