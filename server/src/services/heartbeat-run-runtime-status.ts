import type { HeartbeatRunStatusPhase } from "@paperclipai/shared";

export const HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS = 90_000;
export const MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS = 180;
export const MAX_HEARTBEAT_RUN_RUNTIME_TOOL_NAME_CHARS = 80;
export const MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS = 220;

export interface HeartbeatRunRuntimeStatus {
  companyId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  phase: HeartbeatRunStatusPhase;
  message: string;
  updatedAt: Date;
  currentToolName: string | null;
  lastAssistantSnippet: string | null;
  lastEventAt: Date | null;
}

const runtimeStatusesByRunId = new Map<string, HeartbeatRunRuntimeStatus>();

function cloneStatus(status: HeartbeatRunRuntimeStatus): HeartbeatRunRuntimeStatus {
  return {
    ...status,
    updatedAt: new Date(status.updatedAt),
    lastEventAt: status.lastEventAt ? new Date(status.lastEventAt) : null,
  };
}

const PHASE_MESSAGES: Record<HeartbeatRunStatusPhase, string> = {
  git_sync: "Syncing git workspace",
  config_sync: "Syncing workspace configuration",
  adapter_startup: "Starting adapter",
  restore: "Restoring workspace",
  export: "Exporting workspace",
  finalize: "Finalizing run",
  run_activity: "Agent working",
};

function isExpired(status: HeartbeatRunRuntimeStatus, now: Date, ttlMs: number) {
  return now.getTime() - status.updatedAt.getTime() > ttlMs;
}

export function setHeartbeatRunRuntimeStatus(
  input: Omit<
    HeartbeatRunRuntimeStatus,
    "message" | "updatedAt" | "currentToolName" | "lastAssistantSnippet" | "lastEventAt"
  > & {
    message: string;
    updatedAt?: Date;
    currentToolName?: string | null;
    lastAssistantSnippet?: string | null;
    lastEventAt?: Date | null;
  },
): HeartbeatRunRuntimeStatus | null {
  // Adapter progress strings and tool/assistant snippets are arbitrary provider
  // output, including unknown secrets. The phase is the only safe display input.
  const message = PHASE_MESSAGES[input.phase] ?? "Agent working";

  const status: HeartbeatRunRuntimeStatus = {
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    runId: input.runId,
    phase: input.phase,
    message,
    updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    currentToolName: null,
    lastAssistantSnippet: null,
    lastEventAt: input.lastEventAt ? new Date(input.lastEventAt) : null,
  };
  runtimeStatusesByRunId.set(status.runId, status);
  return cloneStatus(status);
}

/**
 * Refresh the activity timestamps of an existing runtime status without
 * discarding its message/tool context, so streamed run-log output keeps the
 * "Working... / X ago" line fresh between structured events. When no live
 * status exists (first output, or the previous one expired past the TTL), a
 * fallback `run_activity` status is created instead.
 */
export function touchHeartbeatRunRuntimeStatus(input: {
  companyId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  at?: Date;
  fallbackPhase?: HeartbeatRunStatusPhase;
  fallbackMessage?: string;
}): HeartbeatRunRuntimeStatus | null {
  const at = input.at ?? new Date();
  const existing = runtimeStatusesByRunId.get(input.runId);
  if (
    existing &&
    !isExpired(existing, at, HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS) &&
    existing.companyId === input.companyId &&
    existing.agentId === input.agentId
  ) {
    if (at.getTime() > existing.updatedAt.getTime()) {
      existing.updatedAt = new Date(at);
    }
    if (!existing.lastEventAt || at.getTime() > existing.lastEventAt.getTime()) {
      existing.lastEventAt = new Date(at);
    }
    return cloneStatus(existing);
  }
  return setHeartbeatRunRuntimeStatus({
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    runId: input.runId,
    phase: input.fallbackPhase ?? "run_activity",
    message: input.fallbackMessage ?? "Receiving agent output",
    updatedAt: at,
    lastEventAt: at,
  });
}

export function getHeartbeatRunRuntimeStatus(
  runId: string,
  expected?: {
    companyId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
    now?: Date;
    ttlMs?: number;
  },
): HeartbeatRunRuntimeStatus | null {
  const status = runtimeStatusesByRunId.get(runId);
  if (!status) return null;

  const now = expected?.now ?? new Date();
  const ttlMs = expected?.ttlMs ?? HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS;
  if (isExpired(status, now, ttlMs)) {
    runtimeStatusesByRunId.delete(runId);
    return null;
  }

  if (expected?.companyId !== undefined && status.companyId !== expected.companyId) return null;
  if (expected?.issueId !== undefined && status.issueId !== expected.issueId) return null;
  if (expected?.agentId !== undefined && status.agentId !== expected.agentId) return null;

  return cloneStatus(status);
}

export function clearHeartbeatRunRuntimeStatus(runId: string): boolean {
  return runtimeStatusesByRunId.delete(runId);
}

export function clearAllHeartbeatRunRuntimeStatuses(): void {
  runtimeStatusesByRunId.clear();
}

export function sweepExpiredHeartbeatRunRuntimeStatuses(
  now = new Date(),
  ttlMs = HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS,
): number {
  let swept = 0;
  for (const [runId, status] of runtimeStatusesByRunId) {
    if (!isExpired(status, now, ttlMs)) continue;
    runtimeStatusesByRunId.delete(runId);
    swept += 1;
  }
  return swept;
}
