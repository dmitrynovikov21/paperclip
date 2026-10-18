import { and, eq, gte, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

// A completed wake covers only the ready state that produced it. A blocker can
// leave done and later complete again while its dependent stays blocked, so the
// dependent's blocked transition and the edge ids alone cannot identify a cycle.
function coveringWakeStatusCondition(readyAt: Date | null) {
  if (!readyAt) return inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]);
  return or(
    inArray(agentWakeupRequests.status, [...IN_FLIGHT_DEPENDENCY_WAKE_STATUSES]),
    and(eq(agentWakeupRequests.status, "completed"), gte(agentWakeupRequests.requestedAt, readyAt)),
  );
}

/** Latest completion of the current blocker set, used as its ready-state epoch. */
export async function getIssueBlockersResolvedReadyAt(
  db: Db,
  input: { companyId: string; blockerIssueIds: string[] },
): Promise<Date | null> {
  const blockerIssueIds = [...new Set(input.blockerIssueIds.filter(Boolean))];
  if (blockerIssueIds.length === 0) return null;
  const rows = await db
    .select({ completedAt: issues.completedAt })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, blockerIssueIds)));
  return rows.reduce<Date | null>((latest, row) => {
    if (!row.completedAt || (latest && latest >= row.completedAt)) return latest;
    return row.completedAt;
  }, null);
}

export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

export async function findExistingIssueBlockersResolvedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
    readyAt?: Date | null;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        coveringWakeStatusCondition(input.readyAt ?? null),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
    readyAt?: Date | null;
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        coveringWakeStatusCondition(input.readyAt ?? null),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
