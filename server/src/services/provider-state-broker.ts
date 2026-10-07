import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNotNull, ne } from "drizzle-orm";
import {
  agents, agentTaskSessions, companies, environmentLeases, environments, heartbeatRuns, issues, providerStateScopes,
  type Db,
} from "@paperclipai/db";
import {
  ProviderSessionIsolationRequired,
  type ProviderSessionBinding,
  type ProviderStateScope,
} from "@paperclipai/adapter-utils";
import {
  attestProviderSessionIsolation, boundedProviderStateOperation, getProviderStateCleanupDriver,
  requireProviderSessionAttestation, requireTrustedProviderStateDriver,
  issueProviderSessionBinding, requireCurrentProviderStateDriver, requireProviderStateDriverForEnvironment,
  type ProviderStateDriverRequest, type TrustedProviderStateDriverRegistration,
} from "./provider-state-driver.js";

export const PROVIDER_STATE_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROVIDER_STATE_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Lease = typeof environmentLeases.$inferSelect;
export type ProviderStateDestroyReason = "reset" | "terminal" | "agent_deleted" | "company_deleted" |
  "company_archived" | "expired" | "prepare_failed";
export interface ProviderStateSelector {
  companyId: string;
  agentId?: string;
  issueId?: string;
  taskScopeId?: string;
  leaseId?: string;
  executionWorkspaceId?: string;
}

/** Deterministic opaque identity; raw task keys never enter driver metadata. */
export function providerStateScope(input: {
  companyId: string; agentId: string; adapterType: string; taskKey: string;
}): ProviderStateScope {
  const hex = createHash("sha256").update(JSON.stringify([
    "provider-state-v1", input.companyId, input.agentId, input.adapterType, input.taskKey,
  ])).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const id = hex.join("");
  return { companyId: input.companyId, agentId: input.agentId, adapterType: input.adapterType,
    taskScopeId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` };
}

async function lockScope(tx: Tx, id: string) {
  await tx.insert(providerStateScopes).values({ id }).onConflictDoNothing();
  return (await tx.select().from(providerStateScopes).where(eq(providerStateScopes.id, id)).for("update"))[0]!;
}

function leaseRequest(lease: Lease): ProviderStateDriverRequest {
  if (!lease.taskScopeId || !lease.providerStateAgentId || !lease.providerStateAdapterType || !lease.providerStateRef) {
    throw new ProviderSessionIsolationRequired();
  }
  return {
    scope: { companyId: lease.companyId, agentId: lease.providerStateAgentId,
      adapterType: lease.providerStateAdapterType, taskScopeId: lease.taskScopeId },
    environmentId: lease.environmentId, leaseId: lease.id,
    generation: lease.providerStateGeneration, stateRef: lease.providerStateRef,
  };
}

function scopeMatches(lease: Lease, scope: ProviderStateScope) {
  return lease.companyId === scope.companyId && lease.providerStateAgentId === scope.agentId &&
    lease.providerStateAdapterType === scope.adapterType && lease.taskScopeId === scope.taskScopeId;
}

async function requireOwners(tx: Tx, scope: ProviderStateScope, issueId: string | null) {
  const owner = await tx.select({ agentStatus: agents.status, adapterType: agents.adapterType, companyStatus: companies.status })
    .from(agents).innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId))).limit(1);
  if (!owner[0] || owner[0].adapterType !== scope.adapterType ||
      owner[0].agentStatus === "terminated" || owner[0].companyStatus === "archived") {
    throw new ProviderSessionIsolationRequired();
  }
  if (issueId) {
    const issue = (await tx.select({ status: issues.status }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, scope.companyId))))[0];
    if (!issue || issue.status === "done" || issue.status === "cancelled") throw new ProviderSessionIsolationRequired();
  }
}

/** Use in the SAME transaction as reset/terminal/owner deletion. No external IO. */
export async function invalidateProviderStateInTx(
  tx: Tx, selector: ProviderStateSelector, reason: ProviderStateDestroyReason, now = new Date(),
): Promise<string[]> {
  const conditions = [eq(environmentLeases.companyId, selector.companyId), isNotNull(environmentLeases.providerStateStatus),
    ne(environmentLeases.providerStateStatus, "destroyed")];
  if (selector.agentId) conditions.push(eq(environmentLeases.providerStateAgentId, selector.agentId));
  if (selector.issueId) conditions.push(eq(environmentLeases.issueId, selector.issueId));
  if (selector.taskScopeId) conditions.push(eq(environmentLeases.taskScopeId, selector.taskScopeId));
  if (selector.leaseId) conditions.push(eq(environmentLeases.id, selector.leaseId));
  if (selector.executionWorkspaceId) conditions.push(eq(environmentLeases.executionWorkspaceId, selector.executionWorkspaceId));
  let candidates = await tx.select().from(environmentLeases).where(and(...conditions));
  const scopeIds = [...new Set(candidates.map((lease) => lease.taskScopeId!).filter(Boolean))];
  if (selector.taskScopeId) scopeIds.push(selector.taskScopeId);
  // Stable lock order also serializes reset BEFORE the first lease is created.
  for (const scopeId of [...new Set(scopeIds)].sort()) {
    const fence = await lockScope(tx, scopeId);
    if (fence.currentLeaseId && !candidates.some((lease) => lease.id === fence.currentLeaseId)) {
      const row = (await tx.select().from(environmentLeases).where(eq(environmentLeases.id, fence.currentLeaseId)))[0];
      if (row && row.companyId === selector.companyId && row.providerStateStatus !== "destroyed") candidates.push(row);
    }
    await tx.update(providerStateScopes).set({ generation: fence.generation + 1, updatedAt: now })
      .where(eq(providerStateScopes.id, scopeId));
  }
  const invalidated: string[] = [];
  for (const candidate of candidates) {
    const lease = (await tx.select().from(environmentLeases).where(eq(environmentLeases.id, candidate.id)).for("update"))[0];
    if (!lease || lease.providerStateStatus === "destroyed") continue;
    if (lease.providerStateStatus === "active" || lease.providerStateStatus === "provisioning") {
      await tx.update(environmentLeases).set({
        providerStateGeneration: lease.providerStateGeneration + 1,
        providerStateStatus: "pending_cleanup", providerStateTombstonedAt: now,
        status: "pending_cleanup", cleanupStatus: "pending", failureReason: reason, updatedAt: now,
      }).where(eq(environmentLeases.id, lease.id));
    }
    await tx.update(agentTaskSessions).set({
      sessionParamsJson: null, sessionDisplayId: null, providerStateLeaseId: null,
      providerStateGeneration: null, updatedAt: now,
    }).where(eq(agentTaskSessions.providerStateLeaseId, lease.id));
    // Historical outcomes are retained, but late provider pointers are not.
    await tx.update(heartbeatRuns).set({ sessionIdAfter: null })
      .where(and(eq(heartbeatRuns.companyId, lease.companyId),
        eq(heartbeatRuns.agentId, lease.providerStateAgentId!), eq(heartbeatRuns.id, lease.heartbeatRunId!)));
    invalidated.push(lease.id);
  }
  return invalidated;
}

export function providerStateBroker(db: Db, options: { now?: () => Date; operationTimeoutMs?: number } = {}) {
  const now = options.now ?? (() => new Date());

  async function readActive(scope: ProviderStateScope, leaseId: string, generation: number, tx: Tx) {
    const fence = await lockScope(tx, scope.taskScopeId);
    const lease = (await tx.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)).for("update"))[0];
    if (!lease || !scopeMatches(lease, scope) || !["active", "released", "retained"].includes(lease.status) ||
        lease.providerStateStatus !== "active" ||
        lease.providerStateTombstonedAt !== null || lease.providerStateGeneration !== generation ||
        fence.generation !== generation || fence.currentLeaseId !== leaseId ||
        !lease.expiresAt || lease.expiresAt <= now() || !lease.providerStateHardExpiresAt || lease.providerStateHardExpiresAt <= now()) {
      throw new ProviderSessionIsolationRequired();
    }
    await requireOwners(tx, scope, lease.issueId);
    const environment = (await tx.select().from(environments).where(eq(environments.id, lease.environmentId)))[0];
    if (!environment || environment.status !== "active") throw new ProviderSessionIsolationRequired();
    requireCurrentProviderStateDriver(lease.providerStateDriverId!, lease.providerStateDriverRevision!,
      lease.providerStateConfigurationDigest!, environment);
    return lease;
  }

  function bind(lease: Lease, attestation: ProviderSessionBinding["attestation"]): ProviderSessionBinding {
    const request = leaseRequest(lease);
    return issueProviderSessionBinding({
      leaseId: lease.id, generation: lease.providerStateGeneration, attestation,
      async assertWritable() {
        requireProviderSessionAttestation(attestation, request, now());
        await db.transaction((tx) => readActive(request.scope, lease.id, request.generation, tx));
      },
    });
  }

  async function retryCleanup(leaseId: string): Promise<"destroyed" | "cleanup_failed" | "pending_cleanup"> {
    const snapshot = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0];
    if (!snapshot?.taskScopeId) throw new ProviderSessionIsolationRequired();
    const claim = randomUUID();
    const lease = await db.transaction(async (tx) => {
      await lockScope(tx, snapshot.taskScopeId!);
      const row = (await tx.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)).for("update"))[0];
      if (!row || row.providerStateStatus === "destroyed") return null;
      if (!["pending_cleanup", "cleanup_failed"].includes(row.providerStateStatus ?? "")) throw new ProviderSessionIsolationRequired();
      if (row.providerStateCleanupClaim && row.providerStateCleanupClaimExpiresAt && row.providerStateCleanupClaimExpiresAt > now()) return null;
      return (await tx.update(environmentLeases).set({ providerStateStatus: "pending_cleanup",
        providerStateCleanupClaim: claim,
        providerStateCleanupClaimExpiresAt: new Date(now().getTime() + 5 * 30_000),
      }).where(eq(environmentLeases.id, leaseId)).returning())[0]!;
    });
    if (!lease) return snapshot.providerStateStatus === "destroyed" ? "destroyed" : "pending_cleanup";
    let succeeded = false;
    try {
      const driver = getProviderStateCleanupDriver(lease.providerStateDriverId!,
        lease.providerStateDriverRevision!, lease.providerStateConfigurationDigest!);
      if (!driver) throw new ProviderSessionIsolationRequired();
      const request = leaseRequest(lease);
      const invoke = (op: (request: ProviderStateDriverRequest, signal: AbortSignal) => Promise<void>) =>
        boundedProviderStateOperation((signal) => op(request, signal), options.operationTimeoutMs);
      try {
        await invoke(driver.quiesce);
      } catch {
        // Ack means the entire boundary, including stuck/in-flight children,
        // cannot write. A failed ack leaves a durable non-resumable tombstone.
        await invoke(driver.terminateBoundary);
      }
      await invoke(driver.revokeProjections);
      await invoke(driver.destroy);
      succeeded = true;
    } catch {
      // Driver messages can contain host paths/credentials. Persist enums only.
    }
    return await db.transaction(async (tx) => {
      const fence = await lockScope(tx, lease.taskScopeId!);
      const rows = await tx.update(environmentLeases).set({
        providerStateStatus: succeeded ? "destroyed" : "cleanup_failed",
        cleanupStatus: succeeded ? "success" : "failed", status: succeeded ? "expired" : "pending_cleanup",
        releasedAt: succeeded ? now() : lease.releasedAt,
        providerStateCleanupClaim: null, providerStateCleanupClaimExpiresAt: null, updatedAt: now(),
      }).where(and(eq(environmentLeases.id, lease.id),
        eq(environmentLeases.providerStateGeneration, lease.providerStateGeneration),
        eq(environmentLeases.providerStateCleanupClaim, claim))).returning();
      if (!rows[0]) return "pending_cleanup";
      if (succeeded && fence.currentLeaseId === lease.id) {
        await tx.update(providerStateScopes).set({ currentLeaseId: null, updatedAt: now() })
          .where(eq(providerStateScopes.id, lease.taskScopeId!));
      }
      return succeeded ? "destroyed" : "cleanup_failed";
    });
  }

  return {
    async snapshot(scope: ProviderStateScope): Promise<number> {
      return await db.transaction(async (tx) => (await lockScope(tx, scope.taskScopeId)).generation);
    },

    async acquire(input: {
      scope: ProviderStateScope; expectedGeneration: number; environmentLeaseId: string;
      registration: TrustedProviderStateDriverRegistration; environmentDriver: string;
    }): Promise<ProviderSessionBinding> {
      const driver = requireTrustedProviderStateDriver(input.registration);
      if (driver.environmentDriver !== input.environmentDriver) throw new ProviderSessionIsolationRequired();
      const lease = await db.transaction(async (tx) => {
        // Owner/environment deletion takes these locks before its fence scan.
        // It must see every provisioning lease, including a first acquisition.
        const company = (await tx.select().from(companies).where(eq(companies.id, input.scope.companyId)).for("share"))[0];
        const agent = (await tx.select().from(agents).where(and(eq(agents.id, input.scope.agentId),
          eq(agents.companyId, input.scope.companyId))).for("share"))[0];
        if (!company || company.status === "archived" || !agent || agent.status === "terminated" ||
            agent.adapterType !== input.scope.adapterType) throw new ProviderSessionIsolationRequired();
        const initial = (await tx.select().from(environmentLeases).where(eq(environmentLeases.id, input.environmentLeaseId)))[0];
        if (!initial) throw new ProviderSessionIsolationRequired();
        const environment = (await tx.select().from(environments).where(eq(environments.id, initial.environmentId)).for("share"))[0];
        if (!environment || environment.status !== "active") throw new ProviderSessionIsolationRequired();
        requireProviderStateDriverForEnvironment(input.registration, environment);
        if (initial.issueId) {
          if (providerStateScope({ ...input.scope, taskKey: initial.issueId }).taskScopeId !== input.scope.taskScopeId) {
            throw new ProviderSessionIsolationRequired();
          }
          const issue = (await tx.select().from(issues).where(and(eq(issues.id, initial.issueId),
            eq(issues.companyId, input.scope.companyId))).for("share"))[0];
          if (!issue || issue.status === "done" || issue.status === "cancelled") throw new ProviderSessionIsolationRequired();
        }
        const fence = await lockScope(tx, input.scope.taskScopeId);
        if (fence.generation !== input.expectedGeneration || fence.currentLeaseId) throw new ProviderSessionIsolationRequired();
        const row = (await tx.select().from(environmentLeases).where(eq(environmentLeases.id, input.environmentLeaseId)).for("update"))[0];
        if (!row || row.companyId !== input.scope.companyId || row.providerStateStatus !== null || row.status !== "active") {
          throw new ProviderSessionIsolationRequired();
        }
        await requireOwners(tx, input.scope, row.issueId);
        const start = now();
        const expires = new Date(start.getTime() + PROVIDER_STATE_IDLE_TTL_MS);
        const rows = await tx.update(environmentLeases).set({
          taskScopeId: input.scope.taskScopeId, providerStateAgentId: input.scope.agentId,
          providerStateAdapterType: input.scope.adapterType, providerStateGeneration: fence.generation,
          providerStateStatus: "provisioning", providerStateRef: randomUUID(),
          providerStateDriverId: driver.id, providerStateDriverRevision: driver.revision,
          providerStateConfigurationDigest: driver.configurationDigest,
          providerStateHardExpiresAt: new Date(start.getTime() + PROVIDER_STATE_HARD_TTL_MS),
          expiresAt: row.expiresAt && row.expiresAt < expires ? row.expiresAt : expires,
          lastUsedAt: start, updatedAt: start,
        }).where(eq(environmentLeases.id, row.id)).returning();
        await tx.update(providerStateScopes).set({ currentLeaseId: row.id, updatedAt: start })
          .where(eq(providerStateScopes.id, fence.id));
        return rows[0]!;
      });
      try {
        const attestation = await attestProviderSessionIsolation({ registration: input.registration,
          request: leaseRequest(lease), expiresAt: lease.expiresAt!, now: now(), prepare: true });
        const active = await db.transaction(async (tx) => {
          const fence = await lockScope(tx, input.scope.taskScopeId);
          if (fence.generation !== input.expectedGeneration || fence.currentLeaseId !== lease.id) throw new ProviderSessionIsolationRequired();
          await requireOwners(tx, input.scope, lease.issueId);
          const rows = await tx.update(environmentLeases).set({ providerStateStatus: "active", updatedAt: now() })
            .where(and(eq(environmentLeases.id, lease.id),
              eq(environmentLeases.providerStateGeneration, input.expectedGeneration),
              eq(environmentLeases.providerStateStatus, "provisioning"), gt(environmentLeases.expiresAt, now())))
            .returning();
          if (!rows[0]) throw new ProviderSessionIsolationRequired();
          return rows[0];
        });
        return bind(active, attestation);
      } catch {
        await db.transaction((tx) => invalidateProviderStateInTx(tx,
          { companyId: input.scope.companyId, leaseId: lease.id }, "prepare_failed", now()));
        await retryCleanup(lease.id);
        throw new ProviderSessionIsolationRequired();
      }
    },

    async resume(input: {
      scope: ProviderStateScope; leaseId: string; generation: number;
      registration: TrustedProviderStateDriverRegistration;
    }): Promise<ProviderSessionBinding> {
      const lease = await db.transaction((tx) => readActive(input.scope, input.leaseId, input.generation, tx));
      const driver = requireTrustedProviderStateDriver(input.registration);
      if (lease.providerStateDriverId !== driver.id || lease.providerStateDriverRevision !== driver.revision ||
          lease.providerStateConfigurationDigest !== driver.configurationDigest) throw new ProviderSessionIsolationRequired();
      const attestation = await attestProviderSessionIsolation({ registration: input.registration,
        request: leaseRequest(lease), expiresAt: lease.expiresAt!, now: now() });
      const binding = bind(lease, attestation);
      await binding.assertWritable();
      return binding;
    },

    async touch(scope: ProviderStateScope, binding: ProviderSessionBinding) {
      return await db.transaction(async (tx) => {
        const lease = await readActive(scope, binding.leaseId, binding.generation, tx);
        requireProviderSessionAttestation(binding.attestation, leaseRequest(lease), now());
        const expiresAt = new Date(Math.min(lease.providerStateHardExpiresAt!.getTime(), now().getTime() + PROVIDER_STATE_IDLE_TTL_MS));
        await tx.update(environmentLeases).set({ lastUsedAt: now(), expiresAt, updatedAt: now() })
          .where(eq(environmentLeases.id, lease.id));
        return { generation: lease.providerStateGeneration, expiresAt };
      });
    },

    /** Serializes pointer + sessionIdAfter against reset's same row locks. */
    async commitSession(input: {
      scope: ProviderStateScope; binding: ProviderSessionBinding; taskKey: string;
      sessionParamsJson: Record<string, unknown> | null; sessionDisplayId: string | null; runId: string;
    }): Promise<boolean> {
      if (providerStateScope({ ...input.scope, taskKey: input.taskKey }).taskScopeId !== input.scope.taskScopeId) {
        throw new ProviderSessionIsolationRequired();
      }
      try {
        return await db.transaction(async (tx) => {
          const lease = await readActive(input.scope, input.binding.leaseId, input.binding.generation, tx);
          requireProviderSessionAttestation(input.binding.attestation, leaseRequest(lease), now(), { finalization: true });
          const run = (await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.scope.companyId),
            eq(heartbeatRuns.agentId, input.scope.agentId),
          )))[0];
          if (!run) throw new ProviderSessionIsolationRequired();
          const values = { companyId: input.scope.companyId, agentId: input.scope.agentId,
            adapterType: input.scope.adapterType, taskKey: input.taskKey,
            providerStateLeaseId: lease.id, providerStateGeneration: lease.providerStateGeneration,
            sessionParamsJson: input.sessionParamsJson, sessionDisplayId: input.sessionDisplayId,
            lastRunId: input.runId, lastError: null, updatedAt: now() };
          await tx.insert(agentTaskSessions).values(values).onConflictDoUpdate({
            target: [agentTaskSessions.companyId, agentTaskSessions.agentId, agentTaskSessions.adapterType, agentTaskSessions.taskKey],
            set: values,
          });
          await tx.update(heartbeatRuns).set({ sessionIdAfter: input.sessionDisplayId }).where(eq(heartbeatRuns.id, input.runId));
          await tx.update(environmentLeases).set({ heartbeatRunId: input.runId }).where(eq(environmentLeases.id, lease.id));
          return true;
        });
      } catch (error) {
        if (error instanceof ProviderSessionIsolationRequired) return false;
        throw error;
      }
    },

    async destroy(selector: ProviderStateSelector, reason: ProviderStateDestroyReason) {
      const ids = await db.transaction((tx) => invalidateProviderStateInTx(tx, selector, reason, now()));
      return await Promise.all(ids.map(async (id) => ({ leaseId: id, status: await retryCleanup(id) })));
    },
    retryCleanup,
  };
}
