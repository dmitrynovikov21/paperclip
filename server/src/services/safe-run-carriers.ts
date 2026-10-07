/**
 * The control plane stores execution metadata, never provider or tool text.
 * These projections deliberately do not inspect text for known secrets: an
 * unknown prompt or tool-output value must be discarded just the same.
 */
import { COMPANY_STATUSES, ENVIRONMENT_DRIVERS, ISSUE_EXECUTION_MONITOR_CLEAR_REASONS } from "@paperclipai/shared";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "./recovery/review-path-recovery.js";

export const OMITTED_RUN_CONTENT = "[run content omitted]";

const RUN_STATUSES = new Set([
  "queued", "scheduled_retry", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted",
]);
const ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);
const RETRY_REASONS = new Set([
  "transient_failure", "max_turns_continuation", "interaction_continuation_infra_retry", "missing_issue_comment",
  "provider_quota_recovery", "process_lost", "issue_continuation_needed",
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
  "spawnFailure",
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
  "git_worktree_base_fallback_not_project_workspace", "missing_git_push_remote", "missing_project_id",
]);
const CONFIGURATION_INCOMPLETE_REASONS = new Set(["secret_binding_missing", "codex_credentials_missing"]);
const INTERRUPT_SOURCES = new Set(["issue_comment_interrupt"]);
const WORKSPACE_CLEANLINESS = new Set(["clean", "dirty", "unknown"]);
const WORKSPACE_ANCESTRY_VERDICTS = new Set(["diverged", "ancestor", "descendant", "same", "unknown"]);
const WATCHDOG_CLEANUP_OUTCOMES = new Set([
  "skipped_non_local_adapter", "no_process_metadata", "not_running", "termination_sent_still_running",
  "terminated", "failed",
]);
const ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]{1,12}-\d{1,9}$/;
const SAFE_ERROR_MESSAGES = new Set([
  "Cancelled because the company was archived",
  "Cancelled because the agent reached a per-day heartbeat budget cap before adapter invocation",
  "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead",
  "Cancelled because max-turn continuation no longer owns the issue execution lock before the queued run could start",
  "Cancelled because the in-review participant changed before the queued run could start; the current participant will be woken instead",
  "Cancelled because the continuation summary says the executor should wait for reviewer feedback or approval before more work starts",
  "Scheduled max-turn continuation suppressed because the issue execution lock belongs to a different run",
  "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve",
  "Scheduled retry suppressed because issue dependencies are still blocked",
  "Scheduled retry suppressed because the agent is not invokable",
  "Deferred wake suppressed by active subtree pause hold",
  "Cancelled because the issue was cancelled before the scheduled retry became due",
  "Cancelled because the issue was reassigned before the scheduled retry became due",
  "Execution lock released after issue reassigned to a different agent",
]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MONITOR_CLEAR_REASONS = new Set<string>([...ISSUE_EXECUTION_MONITOR_CLEAR_REASONS, "cleared"]);
const INVOKABILITY_REASONS = new Set([
  "missing", "paused", "terminated", "pending_approval", "unknown_status", "manager_missing",
  "manager_company_mismatch", "manager_terminated", "reporting_cycle", "reporting_chain_too_deep",
]);
const WAKE_REASONS = new Set([
  "heartbeat_timer", "issue_assigned", "issue_checked_out", "issue_commented",
  "issue_comment_mentioned", "issue_status_changed", "issue_children_completed",
  "issue_blockers_resolved", "issue_reopened_via_comment", "issue_tree_restored",
  "issue_recovery_action_restored", "issue_monitor_due", "issue_monitor_recovery",
  "issue_monitor_recovery_issue", "execution_review_requested", "execution_approval_requested",
  "execution_changes_requested", "execution_review_participant_recovery",
  "interaction_pending", "approval_approved", "missing_issue_comment", "process_lost_retry",
  "workspace_busy_retry", "transient_failure_retry", "max_turns_continuation_retry",
  "interaction_continuation_infra_retry", "skill_test_run_created", "secret_proposal_resolved",
  "issue_execution_promoted", "issue_execution_deferred", "issue_execution_same_name",
  "issue_rewake_throttled", "issue_dependencies_blocked", "summary_slot_generation_requested",
  "status_card_compile_assigned", "status_card_update_assigned", "retry_failed_run",
  "issue_assignment_recovery", "issue_continuation_needed", "provider_quota_recovery", "manual",
  "finish_successful_run_handoff", "run_liveness_continuation", "issue_review_path_lost",
]);
const CONTEXT_SOURCES = new Set([
  "scheduler", "issue.assignment_recovery", "issue.continuation_recovery",
  "issue.assigned_todo_liveness_dispatch", "issue.execution_review_recovery",
  "issue.execution_stage", "issue.monitor", "issue.monitor.recovery",
  "issue.monitor.recovery_issue", "issue.comment", "issue.update", "issue.checkout",
  "issue.status_change", "issue.children_completed", "issue.blockers_resolved",
  "issue.comment.reopen", "issue.tree_restore", "approval.approved",
  "execution_workspace.quarantine_restore", "issue.recovery_action_resolution",
  "issue.interaction.accept", "issue.interaction.reject", "issue.interaction.respond",
  "issue.interaction.verdicts", "issue.interaction.created", "issue.interaction.cancel",
  "issue.interaction.withdraw", "comment.mention", "issue.stop_relay",
  "issue_recovery_action",
  "issue.interaction_continuation_recovery", "issue.productive_terminal_continuation_recovery",
]);
const REVIEW_RECOVERY_INSTRUCTION =
  "The previous reviewer run ended while this execution-review stage was still pending. Submit the review decision now, or mark the issue blocked with the exact unblock action.";
const CONTEXT_CODES: Record<string, Set<string>> = {
  wakeReason: WAKE_REASONS,
  retryReason: new Set([
    "transient_failure", "max_turns_continuation", "interaction_continuation_infra_retry",
    "missing_issue_comment", "provider_quota_recovery", "workspace_busy", "process_lost",
    "execution_review_participant_recovery", "assignment_recovery", "issue_continuation_needed",
  ]),
  source: CONTEXT_SOURCES,
  wakeSource: new Set(["timer", "assignment", "on_demand", "automation"]),
  wakeTriggerDetail: new Set(["manual", "ping", "callback", "system"]),
  modelProfile: new Set(["cheap", "status_only"]),
  recoveryIntent: new Set(["status_only"]),
  interactionKind: new Set(["ask_user_questions", "request_confirmation", "suggest_tasks"]),
  interactionStatus: new Set(["pending", "accepted", "answered", "rejected", "responded", "cancelled"]),
  continuationPolicy: new Set(["wake_assignee", "wake_assignee_on_accept", "none"]),
  currentStageType: new Set(["review", "approval"]),
  livenessContinuationState: new Set([
    "completed", "advanced", "plan_only", "empty_response", "blocked", "failed", "needs_followup",
    "quarantined_low_trust_handoff",
  ]),
  handoffReason: new Set(["successful_run_missing_state"]),
  missingDisposition: new Set(["clear_next_step"]),
  errorFamily: ERROR_FAMILIES,
  recoveryCause: new Set([
    "workspace_validation_failed", "configuration_incomplete", "execution_review_participant_recovery",
    "successful_run_missing_state", "stranded_assigned_issue", "process_lost",
  ]),
  workspaceRefreshReason: new Set(["accepted_plan_confirmation"]),
  interactionContinuationPolicy: new Set(["wake_assignee", "wake_assignee_on_accept", "none"]),
  codexTransientFallbackMode: new Set(["same_session", "safer_invocation", "fresh_session", "fresh_session_safer_invocation"]),
  executionEngine: new Set(["cli", "acp"]),
  processTopology: new Set(["detached", "server_stdio"]),
  mutation: new Set(["interaction", "comment"]),
};
const CONTEXT_UUID_KEYS = [
  "commentId", "wakeCommentId", "projectId", "projectWorkspaceId", "responsibleUserId", "interactionId",
  "annotationCommentId", "retryOfRunId", "missingIssueCommentForRunId",
  "livenessContinuationSourceRunId", "recoveryActionId", "resumeFromRunId",
  "interruptedRunId", "executionWorkspaceId", "sourceIssueId",
  "currentStageId", "sourceRunId", "strandedRunId",
] as const;
const CONTEXT_BOOLEANS = [
  "forceFreshSession", "skipIssueComment", "timerClaimWasFirstHeartbeat",
  "workspaceBusyDeferredWhileAssignee", "dependencyBlockedInteraction", "treeHoldInteraction",
  "childIssueSummaryTruncated", "checkedOutByHarness",
  "allowDeliverableWork", "allowDocumentUpdates", "resumeRequiresNormalModel",
  "handoffRequired", "reviewPathLost", "resumeIntent", "followUpRequested",
] as const;
const CONTEXT_COUNTS = [
  "scheduledRetryAttempt", "livenessContinuationAttempt", "livenessContinuationMaxAttempts",
  "continuationAttempt",
  "handoffAttempt", "maxHandoffAttempts", "reviewPathRecoveryAttempt", "maxReviewPathRecoveryAttempts",
] as const;
const CONTEXT_TIMESTAMPS = [
  "scheduledRetryAt", "retryNowRequestedAt", "transientRetryNotBefore", "providerQuotaRetryNotBefore",
  "interactionResolvedAt",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positivePid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function allowedCode(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function safeReviewPathConsumedRef(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  if (UUID_RE.test(value)) return value;
  if (value.startsWith("interactions:")) {
    const ids = value.slice("interactions:".length).split(",");
    return ids.length > 1 && ids.length <= 64 && ids.every((id) => UUID_RE.test(id)) ? value : null;
  }
  if (value.startsWith("monitor:")) {
    const match = /^monitor:([^:]+):([^:]+):(.+)$/.exec(value);
    if (!match || !UUID_RE.test(match[1]!) || !MONITOR_CLEAR_REASONS.has(match[2]!)) return null;
    const ref = match[3]!;
    if (/^(?:unknown|\d{1,9})$/.test(ref) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ref)) {
      return value;
    }
  }
  return null;
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
  const projectWorkspaceId = source.issueProjectWorkspaceId;
  if (typeof projectWorkspaceId === "string" && UUID_RE.test(projectWorkspaceId)) {
    safe.issueProjectWorkspaceId = projectWorkspaceId;
  }
  if (source.issueProjectId === null) safe.issueProjectId = null;
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
  if (typeof value !== "string") return "Run failed";
  if (SAFE_ERROR_MESSAGES.has(value)) return value;
  const invokabilityPrefix = "Cancelled because the agent is not invokable: ";
  if (value.startsWith(invokabilityPrefix) && INVOKABILITY_REASONS.has(value.slice(invokabilityPrefix.length))) {
    return value;
  }
  const companyPrefix = "Wake suppressed because company status is ";
  if (value.startsWith(companyPrefix) && (
    COMPANY_STATUSES.includes(value.slice(companyPrefix.length) as typeof COMPANY_STATUSES[number])
    || value.slice(companyPrefix.length) === "missing"
  )) return value;
  for (const prefix of [
    "Cancelled because max-turn continuation issue is no longer in_progress (current status: ",
    "Scheduled max-turn continuation suppressed because issue is no longer in_progress (current status: ",
  ]) {
    if (value.startsWith(prefix)) {
      const suffix = value.slice(prefix.length);
      const status = suffix.split(")")[0];
      if (ISSUE_STATUSES.has(status!) && (
        suffix === `${status})` || suffix === `${status}) before the queued run could start`
      )) return value;
    }
  }
  return "Run failed";
}

/** Persist only typed routing metadata. The adapter receives its full context in memory. */
export function projectSafeRunContextSnapshot(value: unknown): Record<string, unknown> {
  const source = record(value);
  if (!source) return {};
  const safe: Record<string, unknown> = {};
  for (const key of ["issueId", "taskId", "taskKey"] as const) {
    const id = source[key];
    if (typeof id === "string" && (UUID_RE.test(id) || ISSUE_IDENTIFIER_RE.test(id))) safe[key] = id;
  }
  for (const key of CONTEXT_UUID_KEYS) {
    const id = source[key];
    if (typeof id === "string" && UUID_RE.test(id)) safe[key] = id;
  }
  for (const [key, allowed] of Object.entries(CONTEXT_CODES)) {
    const code = allowedCode(source[key], allowed);
    if (code) safe[key] = code;
  }
  for (const key of CONTEXT_BOOLEANS) {
    if (typeof source[key] === "boolean") safe[key] = source[key];
  }
  for (const key of CONTEXT_COUNTS) {
    const count = finiteNumber(source[key]);
    if (count !== null && Number.isSafeInteger(count) && count >= 0) safe[key] = count;
  }
  for (const key of CONTEXT_TIMESTAMPS) {
    const timestamp = source[key];
    if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T/.test(timestamp)) {
      const date = new Date(timestamp);
      if (!Number.isNaN(date.getTime())) safe[key] = date.toISOString();
    }
  }
  if (source.reviewRecoveryInstruction === REVIEW_RECOVERY_INSTRUCTION) {
    safe.reviewRecoveryInstruction = REVIEW_RECOVERY_INSTRUCTION;
  }
  if (source.reviewPathInstruction === REVIEW_PATH_RECOVERY_INSTRUCTION) {
    safe.reviewPathInstruction = REVIEW_PATH_RECOVERY_INSTRUCTION;
  }
  const consumedRef = safeReviewPathConsumedRef(source.reviewPathConsumedRef);
  if (consumedRef) safe.reviewPathConsumedRef = consumedRef;
  const environment = record(source.paperclipEnvironment);
  if (environment) {
    const safeEnvironment: Record<string, unknown> = {};
    for (const key of ["id", "leaseId"] as const) {
      const id = environment[key];
      if (typeof id === "string" && UUID_RE.test(id)) safeEnvironment[key] = id;
    }
    const driver = allowedCode(environment.driver, new Set(ENVIRONMENT_DRIVERS));
    if (driver) safeEnvironment.driver = driver;
    if (driver === "local" && environment.name === "Local") safeEnvironment.name = "Local";
    if (Object.keys(safeEnvironment).length) safe.paperclipEnvironment = safeEnvironment;
  }
  const validationRecovery = record(source.workspaceValidationRecovery);
  if (validationRecovery?.strategy === "quarantine_failed_workspace_and_retry_clean") {
    const safeRecovery: Record<string, unknown> = { strategy: validationRecovery.strategy };
    const reason = allowedCode(validationRecovery.reason, WORKSPACE_VALIDATION_REASONS);
    if (reason) safeRecovery.reason = reason;
    for (const key of ["sourceRunId", "failedExecutionWorkspaceId"] as const) {
      const id = validationRecovery[key];
      if (typeof id === "string" && UUID_RE.test(id)) safeRecovery[key] = id;
    }
    const fingerprint = validationRecovery.fingerprint;
    if (typeof fingerprint === "string" && /^workspace_incoherence:v1:sha256:[a-f0-9]{64}$/.test(fingerprint)) {
      safeRecovery.fingerprint = fingerprint;
    }
    safe.workspaceValidationRecovery = safeRecovery;
  }
  const activeTreeHold = record(source.activeTreeHold);
  if (activeTreeHold && typeof activeTreeHold.rootIssueId === "string" && UUID_RE.test(activeTreeHold.rootIssueId)) {
    const safeHold: Record<string, unknown> = { rootIssueId: activeTreeHold.rootIssueId };
    if (typeof activeTreeHold.holdId === "string" && UUID_RE.test(activeTreeHold.holdId)) {
      safeHold.holdId = activeTreeHold.holdId;
    }
    if (activeTreeHold.mode === "pause") safeHold.mode = "pause";
    if (typeof activeTreeHold.interaction === "boolean") safeHold.interaction = activeTreeHold.interaction;
    safe.activeTreeHold = safeHold;
  }
  if (source.livenessContinuationReason != null) {
    safe.livenessContinuationReason = projectSafeLivenessReason(source.livenessContinuationReason);
  }
  if (source.livenessContinuationState === "quarantined_low_trust_handoff") {
    // This instruction is generated from a known state; never copy a supplied
    // continuation instruction or reason into the persistent run snapshot.
    safe.livenessContinuationReason = "Low-trust review output requires sanitized follow-up.";
    safe.livenessContinuationInstruction = "Continue from the sanitized quarantine stub only.";
  }
  const wakeCommentIds = source.wakeCommentIds;
  if (Array.isArray(wakeCommentIds)) {
    safe.wakeCommentIds = wakeCommentIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
  }
  const blockers = source.unresolvedBlockerIssueIds;
  if (Array.isArray(blockers)) {
    safe.unresolvedBlockerIssueIds = blockers.filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
  }
  const manifest = record(source.paperclipSecrets)?.manifest;
  if (Array.isArray(manifest)) {
    safe.paperclipSecrets = {
      manifest: manifest.flatMap((item) => {
        const bindingId = record(item)?.bindingId;
        return typeof bindingId === "string" && UUID_RE.test(bindingId) ? [{ bindingId }] : [];
      }),
    };
  }
  const stage = record(source.executionStage);
  if (stage) {
    const safeStage: Record<string, unknown> = {};
    const wakeRole = allowedCode(stage.wakeRole, new Set(["reviewer", "approver", "executor"]));
    const stageType = allowedCode(stage.stageType, new Set(["review", "approval"]));
    const outcome = allowedCode(stage.lastDecisionOutcome, new Set(["approved", "changes_requested"]));
    if (wakeRole) safeStage.wakeRole = wakeRole;
    if (stageType) safeStage.stageType = stageType;
    if (outcome) safeStage.lastDecisionOutcome = outcome;
    if (typeof stage.stageId === "string" && UUID_RE.test(stage.stageId)) safeStage.stageId = stage.stageId;
    if (Array.isArray(stage.allowedActions)) {
      const actions = new Set(["approve", "request_changes", "address_changes", "resubmit"]);
      safeStage.allowedActions = stage.allowedActions.filter((action): action is string => typeof action === "string" && actions.has(action));
    }
    for (const key of ["currentParticipant", "returnAssignee"] as const) {
      const participant = record(stage[key]);
      const type = allowedCode(participant?.type, new Set(["agent", "user"]));
      if (!type) continue;
      const idKey = type === "agent" ? "agentId" : "userId";
      const id = participant?.[idKey];
      if (typeof id === "string" && UUID_RE.test(id)) safeStage[key] = { type, [idKey]: id };
    }
    if (Object.keys(safeStage).length) safe.executionStage = safeStage;
  }
  return safe;
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

export function projectSafeRunSessionId(_value: unknown): null {
  // Provider output can imitate any session ID format, including a UUID.
  // Legacy run fields are never trusted; server-issued correlation IDs live
  // in a separate run column and provider IDs stay in the session store.
  return null;
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
    } else if (key === "configurationIncomplete") {
      const configuration = record(entry);
      if (!configuration) continue;
      const reason = allowedCode(configuration.reason, CONFIGURATION_INCOMPLETE_REASONS);
      if (reason) {
        safe[key] = {
          reason,
          missingBindingCount: Array.isArray(configuration.missingBindings)
            ? configuration.missingBindings.length : 0,
        };
      }
    } else if (key === "hotRestart") {
      const adoption = record(entry);
      if (adoption?.adopted !== true || typeof adoption.adoptedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(adoption.adoptedAt)) continue;
      const adoptedAt = new Date(adoption.adoptedAt);
      if (Number.isNaN(adoptedAt.getTime())) continue;
      const safeAdoption: Record<string, unknown> = { adopted: true, adoptedAt: adoptedAt.toISOString() };
      for (const pidKey of ["previousServerPid", "newServerPid", "processPid", "processGroupId"] as const) {
        if (adoption[pidKey] === null) safeAdoption[pidKey] = null;
        else {
          const pid = positivePid(adoption[pidKey]);
          if (pid !== null) safeAdoption[pidKey] = pid;
        }
      }
      safe[key] = safeAdoption;
    } else if (key === "operatorInterrupted" && entry === true) {
      safe[key] = true;
    } else if (key === "interruptionSource") {
      const source = allowedCode(entry, INTERRUPT_SOURCES);
      if (source) safe[key] = source;
    } else if (key === "interruptedIssueId" && typeof entry === "string" && UUID_RE.test(entry)) {
      safe[key] = entry;
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
      const task = record(entry)!;
      const safeTask: Record<string, unknown> = {
        stopped: true,
        stopReason: "unmanaged_background_task_stopped",
      };
      if (task.kind === "orphaned_process_group_cleanup") safeTask.kind = task.kind;
      if (task.reason === "unmanaged background task stopped; no durable live path") safeTask.reason = task.reason;
      for (const pidKey of ["processPid", "processGroupId"] as const) {
        if (task[pidKey] === null) safeTask[pidKey] = null;
        else {
          const pid = positivePid(task[pidKey]);
          if (pid !== null) safeTask[pidKey] = pid;
        }
      }
      safe[key] = safeTask;
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
    : rawMessage === "run interrupted by board comment" && eventType === "lifecycle"
      ? rawMessage
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
    if (rawMessage === "run interrupted by board comment" && eventType === "lifecycle") {
      const issueId = payload.issueId;
      if (typeof issueId === "string" && UUID_RE.test(issueId)) safePayload.issueId = issueId;
      const source = allowedCode(payload.source, INTERRUPT_SOURCES);
      if (source) safePayload.source = source;
    }
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
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
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
  if ("sessionIdBefore" in safe) safe.sessionIdBefore = projectSafeRunSessionId(safe.sessionIdBefore);
  if ("sessionIdAfter" in safe) safe.sessionIdAfter = projectSafeRunSessionId(safe.sessionIdAfter);
  if ("contextSnapshot" in safe) safe.contextSnapshot = projectSafeRunContextSnapshot(safe.contextSnapshot);
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
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
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
  if ("sessionIdBefore" in safe) safe.sessionIdBefore = projectSafeRunSessionId(safe.sessionIdBefore);
  if ("sessionIdAfter" in safe) safe.sessionIdAfter = projectSafeRunSessionId(safe.sessionIdAfter);
  if ("contextSnapshot" in safe) {
    const context = projectSafeRunContextSnapshot(safe.contextSnapshot);
    delete context.paperclipSecrets;
    safe.contextSnapshot = context;
  }
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
