/**
 * The control plane stores execution metadata, never provider or tool text.
 * These projections deliberately do not inspect text for known secrets: an
 * unknown prompt or tool-output value must be discarded just the same.
 */
export const OMITTED_RUN_CONTENT = "[run content omitted]";

const RUN_STATUSES = new Set([
  "queued", "scheduled_retry", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted",
]);
const ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);
const RETRY_REASONS = new Set([
  "transient_failure", "max_turns_continuation", "interaction_continuation_infra_retry", "missing_issue_comment",
  "provider_quota_recovery",
]);
const EVENT_TYPES = new Set(["lifecycle", "adapter.invoke", "error"]);
const EVENT_STREAMS = new Set(["system", "stdout", "stderr"]);
const EVENT_LEVELS = new Set(["info", "warn", "error"]);
const PROCESS_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT", "SIGABRT"]);
const ERROR_CODES = new Set([
  "adapter_failed", "agent_not_found", "agent_not_invokable", "budget_blocked", "cancelled",
  "claude_transient_upstream", "codex_harness_crash", "codex_transient_upstream",
  "configuration_incomplete", "issue_assignee_changed", "issue_cancelled", "issue_continuation_waiting_on_review",
  "heartbeat.daily_cost_limit", "heartbeat.daily_run_limit",
  "issue_dependencies_blocked", "issue_execution_lock_changed", "issue_not_found",
  "issue_not_in_progress", "issue_paused", "issue_reassigned", "issue_review_participant_changed",
  "issue_terminal_status", "lock_released_on_reassignment", "model_not_found", "operator_interrupted",
  "lease_released_before_terminal", "orphaned_running_run", "orphaned_running_run_issue_terminal",
  "process_detached", "process_lost", "provider_quota", "server_shutdown_interrupted",
  "setup_failed", "timeout", "user_secret_missing", "workspace_busy", "workspace_validation_failed",
]);
const STOP_REASONS = new Set([
  "cancelled", "completed", "end_turn", "error", "interrupted", "max_turns_exhausted",
  "process_lost", "refusal", "timeout", "turn_limit_exhausted", "unmanaged_background_task_stopped",
  "issue_dependencies_blocked", "issue_assignee_changed", "issue_continuation_waiting_on_review",
  "issue_execution_lock_changed", "issue_not_in_progress", "issue_review_participant_changed",
  "heartbeat.daily_cost_limit", "heartbeat.daily_run_limit", "claude_poisoned_previous_message_id",
]);
const ERROR_FAMILIES = new Set([
  "provider_quota", "transient_upstream", "configuration_incomplete", "model_refusal",
  "refresh_token_reused", "refresh_token_invalidated", "refresh_token_expired", "auth", "timeout", "process_lost",
]);
const TIMEOUT_SOURCES = new Set([
  "config", "default", "dependency_gate", "heartbeat_daily_cap_gate", "stale_queued_run_gate",
]);
const RESULT_NUMBERS = new Set([
  "costUsd", "cost_usd", "total_cost_usd", "cacheAdjustedCostUsd", "inputTokens",
  "input_tokens", "cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens",
  "outputTokens", "output_tokens", "rawInputTokens", "rawCachedInputTokens",
  "rawOutputTokens", "effectiveTimeoutSec", "effectiveTimeoutMs", "retryAttempt",
  "continuationAttempt", "scheduledRetryAttempt", "maxAttempts", "exitCode", "tokensUsed", "tokensLimit",
  "observed", "limit",
]);
const RESULT_BOOLEANS = new Set([
  "timeoutConfigured", "timeoutFired", "sessionReused", "taskSessionReused", "freshSession",
  "sessionRotated", "stopped", "truncated", "outputOmitted",
]);
const RETRY_TIMESTAMPS = new Set([
  "retryNotBefore", "transientRetryNotBefore", "providerQuotaRetryNotBefore",
]);
const CANCELLATION_ACTORS = new Set(["user", "board", "agent", "system"]);
const BILLING_TYPES = new Set([
  "api", "subscription", "metered", "metered_api", "subscription_included",
  "subscription_overage", "credits", "fixed", "unknown",
]);
const SAFE_LIVENESS_REASONS = new Set([
  "Issue is done", "Issue is cancelled",
  "Run described runnable future work without concrete action evidence",
  "Run described future work that is not safe to auto-continue",
  "Run produced useful output but no concrete action evidence",
  "Run succeeded without useful output or concrete action evidence",
  "Run succeeded without useful output",
  "Planning/document task produced useful output and is exempt from plan-only classification",
  "Run output declared a concrete blocker", "Issue status is blocked",
  "Run liveness classified",
]);
const SAFE_EVIDENCE_LABELS = new Set([
  "issue comment(s)", "document revision(s)", "work product(s)",
  "workspace operation(s)", "activity event(s)", "tool/action event(s)",
]);
const WORKSPACE_VALIDATION_REASONS = new Set([
  "git_worktree_branch_incoherence", "git_worktree_not_reusable",
  "git_worktree_base_fallback_not_project_workspace", "missing_git_push_remote",
]);
const WORKSPACE_CLEANLINESS = new Set(["clean", "dirty", "unknown"]);
const WORKSPACE_ANCESTRY_VERDICTS = new Set(["diverged", "ancestor", "descendant", "same", "unknown"]);
const WATCHDOG_CLEANUP_OUTCOMES = new Set([
  "skipped_non_local_adapter", "no_process_metadata", "not_running", "termination_sent_still_running",
  "terminated", "failed",
]);
const ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]{1,12}-\d{1,9}$/;
const SAFE_ERROR_MESSAGES = new Set([
  "Cancelled because the company was archived",
  "Scheduled retry suppressed because the agent is not invokable",
  "Cancelled because the issue was cancelled before the scheduled retry became due",
  "Cancelled because the issue was reassigned before the scheduled retry became due",
  "Execution lock released after issue reassigned to a different agent",
]);
const SESSION_ID_RE = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{8}_\d{6}_[A-Za-z0-9_-]{4,})$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function allowedCode(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function safeWorkspaceValidation(value: unknown): Record<string, unknown> | null {
  const source = record(value);
  if (!source) return null;
  const safe: Record<string, unknown> = {};
  const reason = allowedCode(source.reason, WORKSPACE_VALIDATION_REASONS);
  if (reason) safe.reason = reason;
  for (const key of ["issueId", "sourceIssueId", "executionWorkspaceId"] as const) {
    const id = source[key];
    if (typeof id === "string" && UUID_RE.test(id)) safe[key] = id;
  }
  const fingerprint = source.fingerprint;
  if (typeof fingerprint === "string" && /^workspace_incoherence:v1:sha256:[a-f0-9]{64}$/.test(fingerprint)) {
    safe.fingerprint = fingerprint;
  }
  const cleanliness = allowedCode(source.cleanliness, WORKSPACE_CLEANLINESS);
  if (cleanliness) safe.cleanliness = cleanliness;
  const repair = record(source.safeRepair);
  if (repair) {
    safe.safeRepair = Object.fromEntries(["eligible", "attempted", "succeeded"]
      .filter((key) => typeof repair[key] === "boolean")
      .map((key) => [key, repair[key]]));
  }
  const provenance = record(source.provenance);
  if (provenance) {
    const safeProvenance: Record<string, unknown> = {};
    const verdict = allowedCode(provenance.ancestryVerdict, WORKSPACE_ANCESTRY_VERDICTS);
    if (verdict) safeProvenance.ancestryVerdict = verdict;
    for (const key of ["expectedHeadSha", "actualHeadSha"] as const) {
      const sha = provenance[key];
      if (typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) safeProvenance[key] = sha;
    }
    if (Object.keys(safeProvenance).length) safe.provenance = safeProvenance;
  }
  return Object.keys(safe).length ? safe : null;
}

export function projectSafeErrorCode(value: unknown): string | null {
  if (value == null) return null;
  return allowedCode(value, ERROR_CODES) ?? "adapter_failed";
}

export function projectSafeError(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" && SAFE_ERROR_MESSAGES.has(value) ? value : "Run failed";
}

export function projectSafeLivenessReason(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return "Run liveness classified";
  if (SAFE_LIVENESS_REASONS.has(value)) return value;
  const prefix = "Run produced concrete action evidence: ";
  if (value.startsWith(prefix)) {
    const parts = value.slice(prefix.length).split(", ");
    if (parts.length > 0 && parts.every((part) => {
      const match = /^(\d+) (.+)$/.exec(part);
      return match && SAFE_EVIDENCE_LABELS.has(match[2]!);
    })) return value;
  }
  return "Run liveness classified";
}

export function projectSafeRunLogChunk(_chunk: string): string {
  return `${OMITTED_RUN_CONTENT}\n`;
}

export function projectSafeUsageJson(value: unknown): Record<string, unknown> | null {
  const source = record(value);
  if (!source) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (RESULT_NUMBERS.has(key)) {
      const number = finiteNumber(entry);
      if (number !== null) safe[key] = number;
    } else if (RESULT_BOOLEANS.has(key) && typeof entry === "boolean") {
      safe[key] = entry;
    } else if ((key === "billingType" || key === "billing_type")) {
      const billingType = allowedCode(entry, BILLING_TYPES);
      if (billingType) safe[key] = billingType;
    }
  }
  return safe;
}

export function projectSafeResultJson(value: unknown): Record<string, unknown> | null {
  const source = record(value);
  if (!source) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (RESULT_NUMBERS.has(key)) {
      const number = finiteNumber(entry);
      if (number !== null) safe[key] = number;
    } else if (RESULT_BOOLEANS.has(key) && typeof entry === "boolean") {
      safe[key] = entry;
    } else if ((key === "billingType" || key === "billing_type")) {
      const billingType = allowedCode(entry, BILLING_TYPES);
      if (billingType) safe[key] = billingType;
    } else if (key === "stopReason") {
      const code = allowedCode(entry, STOP_REASONS);
      if (code) safe[key] = code;
    } else if (key === "errorFamily") {
      const code = allowedCode(entry, ERROR_FAMILIES);
      if (code) safe[key] = code;
    } else if (key === "errorCode") {
      const code = projectSafeErrorCode(entry);
      if (code) safe[key] = code;
    } else if (key === "cancelledByActorType") {
      const actorType = allowedCode(entry, CANCELLATION_ACTORS);
      if (actorType) safe[key] = actorType;
    } else if (key === "timeoutSource") {
      const code = allowedCode(entry, TIMEOUT_SOURCES);
      if (code) safe[key] = code;
    } else if (RETRY_TIMESTAMPS.has(key) && typeof entry === "string") {
      const parsed = new Date(entry);
      if (!Number.isNaN(parsed.getTime())) safe[key] = parsed.toISOString();
    } else if ((key === "sessionId" || key === "session_id") &&
      typeof entry === "string" && entry.length <= 128 && SESSION_ID_RE.test(entry)) {
      // Hermes uses this canonical ID for an explicit resume override.
      safe[key] = entry;
    } else if (key === "workspaceBusy") {
      const busy = record(entry);
      if (!busy) continue;
      const safeBusy: Record<string, unknown> = {};
      for (const idKey of ["projectWorkspaceId", "holderRunId", "holderIssueId"] as const) {
        const id = busy[idKey];
        if (typeof id === "string" && UUID_RE.test(id)) safeBusy[idKey] = id;
      }
      const attempt = finiteNumber(busy.deferralAttempt);
      if (attempt !== null && Number.isInteger(attempt) && attempt >= 0) safeBusy.deferralAttempt = attempt;
      if (Object.keys(safeBusy).length) safe[key] = safeBusy;
    } else if (key === "workspaceValidation") {
      const validation = safeWorkspaceValidation(entry);
      if (validation) safe[key] = validation;
    } else if (key === "sourceResolvedWatchdogFold") {
      const fold = record(entry);
      if (!fold) continue;
      const safeFold: Record<string, unknown> = {};
      for (const idKey of ["sourceIssueId", "sameRunEvidenceId", "evaluationIssueId"] as const) {
        const id = fold[idKey];
        if (id === null) safeFold[idKey] = null;
        else if (typeof id === "string" && UUID_RE.test(id)) safeFold[idKey] = id;
      }
      for (const identifierKey of ["sourceIssueIdentifier", "evaluationIssueIdentifier"] as const) {
        const identifier = fold[identifierKey];
        if (identifier === null) safeFold[identifierKey] = null;
        else if (typeof identifier === "string" && ISSUE_IDENTIFIER_RE.test(identifier)) safeFold[identifierKey] = identifier;
      }
      const issueStatus = allowedCode(fold.sourceIssueStatus, ISSUE_STATUSES);
      if (issueStatus) safeFold.sourceIssueStatus = issueStatus;
      if (fold.sameRunEvidenceKind === "activity") safeFold.sameRunEvidenceKind = "activity";
      for (const timeKey of ["sameRunEvidenceAt", "silenceStartedAt"] as const) {
        const time = fold[timeKey];
        if (time === null) safeFold[timeKey] = null;
        else if (typeof time === "string" && !Number.isNaN(new Date(time).getTime())) {
          safeFold[timeKey] = new Date(time).toISOString();
        }
      }
      const silenceAgeMs = finiteNumber(fold.silenceAgeMs);
      if (silenceAgeMs !== null && silenceAgeMs >= 0) safeFold.silenceAgeMs = silenceAgeMs;
      const cleanup = record(fold.cleanup);
      if (cleanup) {
        const outcome = allowedCode(cleanup.outcome, WATCHDOG_CLEANUP_OUTCOMES);
        if (outcome) safeFold.cleanup = { outcome, attempted: cleanup.attempted === true };
      }
      if (Object.keys(safeFold).length) safe[key] = safeFold;
    } else if (key === "unmanagedBackgroundTask" && record(entry)?.stopped === true) {
      safe[key] = { stopped: true, stopReason: "unmanaged_background_task_stopped" };
    }
  }
  if (Object.keys(safe).length === 0) safe.outputOmitted = true;
  return safe;
}

export function projectSafeRunEvent(input: {
  eventType: string;
  message?: string | null;
  payload?: unknown;
  stream?: unknown;
  level?: unknown;
}): { eventType: string; message: string; payload: Record<string, unknown> | null; stream: string | null; level: string | null } {
  const eventType = EVENT_TYPES.has(input.eventType) ? input.eventType : "adapter.event";
  const rawMessage = typeof input.message === "string" ? input.message : "";
  const message = rawMessage.startsWith("Bounded retry exhausted")
    ? "Bounded retry exhausted"
    : rawMessage.startsWith("run terminalized on environment lease release:")
      ? "run terminalized on environment lease release"
    : rawMessage === "Source-resolved watchdog fold finalized stale active run"
      ? rawMessage
    : rawMessage.startsWith("run terminalized by recovery backstop: issue reached a terminal status")
      ? "run terminalized by recovery backstop: issue reached a terminal status"
    : rawMessage.startsWith("run terminalized by recovery backstop: process and sandbox gone")
      ? "run terminalized by recovery backstop: process and sandbox gone"
    : rawMessage.includes("no longer in_progress")
      ? "Run cancelled because issue is no longer in_progress"
    : eventType === "adapter.invoke"
      ? "adapter invocation"
      : eventType === "error"
        ? "run error"
        : eventType === "lifecycle" &&
          ["run started", "run succeeded", "run failed", "run cancelled", "run timed_out"].includes(rawMessage)
          ? rawMessage
          : "run event";
  const payload = record(input.payload);
  const safePayload: Record<string, unknown> = {};
  if (payload) {
    for (const key of ["status", "previousStatus", "terminalStatus"] as const) {
      const status = allowedCode(payload[key], RUN_STATUSES);
      if (status) safePayload[key] = status;
    }
    for (const key of ["currentStatus", "requiredStatus"] as const) {
      const issueStatus = allowedCode(payload[key], ISSUE_STATUSES);
      if (issueStatus) safePayload[key] = issueStatus;
    }
    for (const key of ["retryReason", "scheduledRetryReason"] as const) {
      const retryReason = allowedCode(payload[key], RETRY_REASONS);
      if (retryReason) safePayload[key] = retryReason;
    }
    const exitCode = finiteNumber(payload.exitCode);
    if (exitCode !== null) safePayload.exitCode = exitCode;
    for (const key of ["scheduledRetryAttempt", "maxAttempts"] as const) {
      const count = finiteNumber(payload[key]);
      if (count !== null) safePayload[key] = count;
    }
    const usage = projectSafeUsageJson(payload.usage);
    if (usage) safePayload.usage = usage;
  }
  return {
    eventType,
    message,
    payload: Object.keys(safePayload).length ? safePayload : null,
    stream: allowedCode(input.stream, EVENT_STREAMS),
    level: allowedCode(input.level, EVENT_LEVELS),
  };
}

export function projectSafeRunPatch<T extends {
  error?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  usageJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  nextAction?: string | null;
  livenessReason?: string | null;
  signal?: string | null;
}>(patch: T): T {
  const safe = { ...patch };
  if ("error" in safe) safe.error = projectSafeError(safe.error);
  if ("errorCode" in safe) safe.errorCode = projectSafeErrorCode(safe.errorCode);
  if ("resultJson" in safe) safe.resultJson = projectSafeResultJson(safe.resultJson);
  if ("usageJson" in safe) safe.usageJson = projectSafeUsageJson(safe.usageJson);
  if ("stdoutExcerpt" in safe) safe.stdoutExcerpt = null;
  if ("stderrExcerpt" in safe) safe.stderrExcerpt = null;
  if ("nextAction" in safe) safe.nextAction = null;
  if ("livenessReason" in safe) safe.livenessReason = projectSafeLivenessReason(safe.livenessReason);
  if ("signal" in safe) safe.signal = allowedCode(safe.signal, PROCESS_SIGNALS);
  return safe;
}

export function projectSafeRunRow<T extends {
  error?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  usageJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  nextAction?: string | null;
  livenessReason?: string | null;
  signal?: string | null;
}>(row: T): T {
  const safe = { ...row };
  if ("error" in safe) safe.error = projectSafeError(safe.error);
  if ("errorCode" in safe) safe.errorCode = projectSafeErrorCode(safe.errorCode);
  if ("resultJson" in safe) safe.resultJson = projectSafeResultJson(safe.resultJson);
  if ("usageJson" in safe) safe.usageJson = projectSafeUsageJson(safe.usageJson);
  if ("stdoutExcerpt" in safe) safe.stdoutExcerpt = null;
  if ("stderrExcerpt" in safe) safe.stderrExcerpt = null;
  if ("nextAction" in safe) safe.nextAction = null;
  if ("livenessReason" in safe) safe.livenessReason = projectSafeLivenessReason(safe.livenessReason);
  if ("signal" in safe) safe.signal = allowedCode(safe.signal, PROCESS_SIGNALS);
  return safe;
}
