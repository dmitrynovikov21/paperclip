CREATE INDEX IF NOT EXISTS "heartbeat_runs_status_agent_idx" ON "heartbeat_runs" USING btree ("status", "agent_id");
