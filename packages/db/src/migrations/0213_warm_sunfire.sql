ALTER TABLE "agent_runtime_state" ADD COLUMN "session_correlation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "session_correlation_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "session_correlation_id" uuid;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_agent_session_correlation_idx" ON "heartbeat_runs" USING btree ("agent_id","session_correlation_id","created_at");