import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, agentRuntimeState, agentTaskSessions, agentWakeupRequests, activityLog, companies, companyMemberships,
  createDb, documents, environmentLeases, environments,
  heartbeatRuns, heartbeatRunEvents, issueComments, issues, providerStateScopes, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { ProviderSessionBinding } from "@paperclipai/adapter-utils";
import {
  providerStateBroker, providerStateScope, PROVIDER_STATE_HARD_TTL_MS, PROVIDER_STATE_IDLE_TTL_MS,
} from "../services/provider-state-broker.js";
import {
  PROVIDER_STATE_DENY_PROBES, registerTrustedProviderStateDriver,
  type ProviderStateConformance, type ProviderStateDriverRequest, type TrustedProviderStateDriver,
} from "../services/provider-state-driver.js";
import { executeWithProviderState, providerStateEnforced } from "../services/provider-state-execution.js";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

function conformance(digest: string): ProviderStateConformance {
  return { version: 1, configurationDigest: digest, effectiveIdentityChecked: true,
    supplementaryGroupsChecked: true, capabilitiesChecked: true, hostRootsMounted: false,
    durableResume: true, idempotentDestroy: true, generationFenceVerified: true, latePrepareDenied: true,
    probes: Object.fromEntries(PROVIDER_STATE_DENY_PROBES.map((key) => [key, "denied"])) as ProviderStateConformance["probes"] };
}

/** Synthetic lifecycle driver, not evidence of a production OS boundary. */
async function syntheticDriver() {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-state-fixture-"));
  const digest = randomBytes(32).toString("hex");
  const artifacts = new Set<string>();
  const destroyed = new Set<string>();
  const children = new Map<string, ChildProcess>();
  const calls: string[] = [];
  let failDestroy = false;
  let stuckChild = false;
  let startChild = false;
  let prepareBarrier: Promise<void> | null = null;
  let notifyPrepared: (() => void) | null = null;
  async function stopChild(ref: string) {
    const child = children.get(ref);
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    children.delete(ref);
  }
  const driver: TrustedProviderStateDriver = {
    id: `synthetic-${randomUUID()}`, revision: "1", configurationDigest: digest,
    environmentDriver: "sandbox", boundaryKind: "isolated_container",
    async installConformance() { return conformance(digest); },
    async prepare(request) {
      calls.push("prepare");
      artifacts.add(request.stateRef);
      await writeFile(path.join(root, request.stateRef), randomBytes(32));
      if (startChild) children.set(request.stateRef, spawn(process.execPath,
        ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
      notifyPrepared?.();
      if (prepareBarrier) await prepareBarrier;
      if (destroyed.has(request.stateRef)) throw new Error("synthetic_writer_fenced");
      return conformance(digest);
    },
    async probe(request) {
      calls.push("probe");
      if (!artifacts.has(request.stateRef) || destroyed.has(request.stateRef)) throw new Error("synthetic_state_missing");
      return conformance(digest);
    },
    async quiesce(request) {
      calls.push("quiesce");
      if (stuckChild) await new Promise<void>(() => {});
      await stopChild(request.stateRef);
    },
    async terminateBoundary(request) { calls.push("terminate"); await stopChild(request.stateRef); },
    async revokeProjections() { calls.push("revoke"); },
    async destroy(request) {
      calls.push("destroy");
      if (failDestroy) throw new Error("synthetic_cleanup_failure");
      destroyed.add(request.stateRef);
      await rm(path.join(root, request.stateRef), { force: true });
      artifacts.delete(request.stateRef);
    },
  };
  return {
    driver, artifacts, children, calls,
    setFailDestroy(value: boolean) { failDestroy = value; },
    setStuckChild() { stuckChild = true; startChild = true; },
    blockPrepare() {
      let release!: () => void;
      const started = new Promise<void>((resolve) => { notifyPrepared = resolve; });
      prepareBarrier = new Promise<void>((resolve) => { release = resolve; });
      return { started, release };
    },
    async cleanup() {
      for (const ref of children.keys()) await stopChild(ref);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("provider-state conformance and execution gate", () => {
  it("fails closed by default, including invalid host mode", () => {
    expect(providerStateEnforced({})).toBe(true);
    expect(providerStateEnforced({ PAPERCLIP_PROVIDER_STATE_MODE: "unknown" })).toBe(true);
    expect(providerStateEnforced({ PAPERCLIP_PROVIDER_STATE_MODE: "observe" })).toBe(false);
  });

  it("does not spawn without a core-issued binding", async () => {
    const execute = vi.fn();
    await expect(executeWithProviderState(null, execute)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(PROVIDER_STATE_DENY_PROBES)("rejects successful escape probe %s", async (probe) => {
    const fixture = await syntheticDriver();
    try {
      fixture.driver.installConformance = async () => ({ ...conformance(fixture.driver.configurationDigest),
        probes: { ...conformance(fixture.driver.configurationDigest).probes, [probe]: "allowed" },
      } as unknown as ProviderStateConformance);
      await expect(registerTrustedProviderStateDriver(fixture.driver)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    } finally { await fixture.cleanup(); }
  });
});

describe("[e2e_db] provider-state broker", () => {
  let db!: ReturnType<typeof createDb>;
  let database!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const fixtures: Awaited<ReturnType<typeof syntheticDriver>>[] = [];
  let clock = new Date("2026-01-01T00:00:00Z");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("provider-state-broker-pg-");
    const url = new URL(database.connectionString);
    if (url.hostname !== "127.0.0.1" || Number(url.port) < 10_000 || url.port === "5432") {
      throw new Error("test_database_isolation_required");
    }
    // This role exists only in this test's disposable cluster. Never print its password.
    const admin = createDb(database.connectionString);
    const role = `broker_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(32).toString("hex");
    try {
      await admin.$client.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await admin.$client.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await admin.$client.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await admin.$client.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    } catch {
      await admin.$client.end();
      throw new Error("synthetic_database_role_setup_failed");
    }
    url.username = role; url.password = password;
    db = createDb(url.toString());
    process.env.PYTEST_DB_PORT = url.port;
    await admin.$client.end();
  }, 30_000);

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.cleanup();
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(providerStateScopes);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companyMemberships);
    await db.delete(companies);
    clock = new Date("2026-01-01T00:00:00Z");
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic company", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic owner", role: "engineer", adapterType: "codex_local", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic task", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(environments).values({ id: environmentId, name: "Synthetic boundary", driver: "sandbox", status: "active", config: {} });
    const lease = await environmentService(db).acquireLease({ companyId, environmentId, issueId, heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment", provider: "synthetic", providerLeaseId: randomUUID() });
    const fixture = await syntheticDriver(); fixtures.push(fixture);
    const registration = await registerTrustedProviderStateDriver(fixture.driver,
      (await environmentService(db).getById(environmentId))!);
    const scope = providerStateScope({ companyId, agentId, adapterType: "codex_local", taskKey: issueId });
    const broker = providerStateBroker(db, { now: () => clock, operationTimeoutMs: 1_000 });
    const expectedGeneration = await broker.snapshot(scope);
    return { companyId, agentId, environmentId, issueId, runId, lease, fixture, registration, scope, broker, expectedGeneration };
  }

  async function acquire(s: Awaited<ReturnType<typeof seed>>) {
    return await s.broker.acquire({ scope: s.scope, expectedGeneration: s.expectedGeneration,
      environmentLeaseId: s.lease.id, registration: s.registration, environmentDriver: "sandbox" });
  }
  async function commit(s: Awaited<ReturnType<typeof seed>>, binding: ProviderSessionBinding) {
    return await s.broker.commitSession({ scope: s.scope, binding, taskKey: s.issueId,
      sessionParamsJson: { sessionId: randomUUID() }, sessionDisplayId: randomUUID(), runId: s.runId });
  }

  it("links session + lease, resumes, touches and keeps state refs out of lease API", async () => {
    const s = await seed(); const binding = await acquire(s);
    expect(await commit(s, binding)).toBe(true);
    const session = (await db.select().from(agentTaskSessions))[0]!;
    expect(session.providerStateLeaseId === s.lease.id).toBe(true);
    expect(session.providerStateGeneration).toBe(binding.generation);
    const resumed = await s.broker.resume({ scope: s.scope, leaseId: s.lease.id,
      generation: binding.generation, registration: s.registration });
    const execute = vi.fn(async () => "succeeded");
    expect(await executeWithProviderState(resumed, execute)).toBe("succeeded");
    expect(execute).toHaveBeenCalledOnce();
    await s.broker.touch(s.scope, resumed);
    expect(s.fixture.artifacts.size).toBe(1);
    const projected = await environmentService(db).getLeaseById(s.lease.id);
    expect(Object.keys(projected!).some((key) => key.startsWith("providerState"))).toBe(false);
  });

  it("fails a real heartbeat before provider spawn without a migrated adapter", async () => {
    const s = await seed();
    // The broker fixture's run must not occupy the agent's sole execution slot.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ assigneeAgentId: s.agentId }).where(eq(issues.id, s.issueId));
    await db.insert(companyMemberships).values({ companyId: s.companyId, principalType: "user",
      principalId: "synthetic-operator", status: "active", membershipRole: "owner" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const result = await heartbeat.invoke(s.agentId, "on_demand", {
      issueId: s.issueId, taskKey: randomUUID(),
    }, "manual", { actorType: "user", actorId: "synthetic-operator" });
    await vi.waitFor(async () => {
      const row = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, result!.id)))[0]!;
      expect(row.status).toBe("failed");
      expect(row.errorCode).toBe("provider_session_isolation_required");
      expect(row.processPid).toBeNull();
    }, { timeout: 8_000, interval: 20 });
    await heartbeat.drainActiveRunExecutions();
    expect(s.fixture.calls.length).toBe(0);
  }, 10_000);

  it("rejects forged metadata registration and forged serialized attestation", async () => {
    const s = await seed();
    await expect(s.broker.acquire({ scope: s.scope, expectedGeneration: s.expectedGeneration,
      environmentLeaseId: s.lease.id, registration: { id: s.fixture.driver.id }, environmentDriver: "sandbox" }))
      .rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(s.fixture.calls.length).toBe(0);
    const binding = await acquire(s);
    const forged = { ...binding, attestation: JSON.parse(JSON.stringify(binding.attestation)) };
    await expect(s.broker.touch(s.scope, forged)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(await commit(s, forged)).toBe(false);
  });

  it("refuses metadata capabilities on unsafe local and SSH lanes", async () => {
    const s = await seed();
    const runtime = environmentRuntimeService(db);
    for (const driver of ["local", "ssh"] as const) {
      const env = { ...(await environmentService(db).getById(s.environmentId))!, driver,
        metadata: { supportsAgentPrivatePersistentState: true, attestation: conformance(s.fixture.driver.configurationDigest) } };
      await expect(runtime.prepareProviderSession({ scope: s.scope, expectedGeneration: s.expectedGeneration,
        environment: env, lease: s.lease })).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    }
    expect(s.fixture.calls.length).toBe(0);
  });

  it.each(["companyId", "agentId", "adapterType", "taskScopeId"] as const)("rejects foreign scope field %s", async (field) => {
    const s = await seed(); const binding = await acquire(s);
    const foreign = { ...s.scope, [field]: field === "adapterType" ? "claude_local" : randomUUID() };
    await expect(s.broker.resume({ scope: foreign, leaseId: binding.leaseId,
      generation: binding.generation, registration: s.registration })).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    await expect(s.broker.touch(foreign, binding)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
  });

  it("rejects stale probe without spawning, and re-probes resume", async () => {
    const s = await seed(); const binding = await acquire(s);
    clock = new Date(clock.getTime() + 60_001);
    const execute = vi.fn();
    await expect(executeWithProviderState(binding, execute)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(execute).not.toHaveBeenCalled();
    const resumed = await s.broker.resume({ scope: s.scope, leaseId: binding.leaseId,
      generation: binding.generation, registration: s.registration });
    await resumed.assertWritable();
    expect(s.fixture.calls.filter((call) => call === "probe").length).toBe(1);
  });

  it("rejects fabricated binding callbacks and a changed environment configuration", async () => {
    const s = await seed(); const binding = await acquire(s);
    const execute = vi.fn();
    await expect(executeWithProviderState({ ...binding, assertWritable: async () => {} }, execute))
      .rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(execute).not.toHaveBeenCalled();
    await db.update(environments).set({ config: { image: "synthetic-new-image" } }).where(eq(environments.id, s.environmentId));
    await expect(binding.assertWritable()).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(await commit(s, binding)).toBe(false);
  });

  it("fences reset before acquire even without a session pointer", async () => {
    const s = await seed();
    await s.broker.destroy({ companyId: s.companyId, taskScopeId: s.scope.taskScopeId }, "reset");
    await expect(acquire(s)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect(s.fixture.calls.length).toBe(0);
  });

  it("terminates a stuck child and rejects late touch/sessionIdAfter after reset", async () => {
    const s = await seed(); s.fixture.setStuckChild(); const binding = await acquire(s);
    expect(await commit(s, binding)).toBe(true);
    expect(s.fixture.children.size).toBe(1);
    const result = await s.broker.destroy({ companyId: s.companyId, taskScopeId: s.scope.taskScopeId }, "reset");
    expect(result.map((item) => item.status)).toEqual(["destroyed"]);
    expect(s.fixture.children.size).toBe(0); expect(s.fixture.artifacts.size).toBe(0);
    expect(s.fixture.calls.slice(-4)).toEqual(["quiesce", "terminate", "revoke", "destroy"]);
    await db.delete(agentTaskSessions); // tombstone survives pointer deletion
    expect(await commit(s, binding)).toBe(false);
    await expect(s.broker.touch(s.scope, binding)).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    expect((await db.select().from(agentTaskSessions)).length).toBe(0);
    expect((await db.select({ id: heartbeatRuns.sessionIdAfter }).from(heartbeatRuns))[0]!.id).toBeNull();
    const row = (await db.select().from(environmentLeases))[0]!;
    expect(row.providerStateGeneration).toBeGreaterThan(binding.generation);
    expect(row.providerStateTombstonedAt != null).toBe(true);
  });

  it("clears the latest resumed run pointer on reset", async () => {
    const s = await seed(); const binding = await acquire(s);
    expect(await commit(s, binding)).toBe(true);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: s.companyId, agentId: s.agentId, status: "running" });
    expect(await s.broker.commitSession({ scope: s.scope, binding, taskKey: s.issueId,
      sessionParamsJson: { sessionId: randomUUID() }, sessionDisplayId: randomUUID(), runId })).toBe(true);
    await s.broker.destroy({ companyId: s.companyId, leaseId: binding.leaseId }, "reset");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.sessionIdAfter).toBeNull();
    expect(await s.broker.commitSession({ scope: s.scope, binding, taskKey: s.issueId,
      sessionParamsJson: {}, sessionDisplayId: randomUUID(), runId })).toBe(false);
  });

  it("does not reactivate a reset lease when prepare finishes late", async () => {
    const s = await seed(); const blocked = s.fixture.blockPrepare();
    const acquiring = acquire(s).then(() => true, () => false);
    await blocked.started;
    await s.broker.destroy({ companyId: s.companyId, taskScopeId: s.scope.taskScopeId }, "reset");
    blocked.release();
    expect(await acquiring).toBe(false);
    expect(s.fixture.artifacts.size).toBe(0);
    expect((await db.select().from(environmentLeases))[0]!.providerStateStatus).toBe("destroyed");
  });

  it("keeps cleanup failure non-resumable and retries idempotently", async () => {
    const s = await seed(); const binding = await acquire(s); s.fixture.setFailDestroy(true);
    const result = await s.broker.destroy({ companyId: s.companyId, leaseId: binding.leaseId }, "reset");
    expect(result.map((item) => item.status)).toEqual(["cleanup_failed"]);
    await expect(s.broker.resume({ scope: s.scope, leaseId: binding.leaseId,
      generation: binding.generation, registration: s.registration })).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    s.fixture.setFailDestroy(false);
    expect(await s.broker.retryCleanup(binding.leaseId)).toBe("destroyed");
    const generation = (await db.select().from(providerStateScopes))[0]!.generation;
    expect(await s.broker.retryCleanup(binding.leaseId)).toBe("destroyed");
    await s.broker.destroy({ companyId: s.companyId, leaseId: binding.leaseId }, "reset");
    expect((await db.select().from(providerStateScopes))[0]!.generation).toBe(generation);
    expect(s.fixture.artifacts.size).toBe(0);
  });

  it("does not let old finalization overwrite a fresh generation", async () => {
    const s = await seed(); const old = await acquire(s);
    await s.broker.destroy({ companyId: s.companyId, leaseId: old.leaseId }, "reset");
    const newLease = await environmentService(db).acquireLease({ companyId: s.companyId, environmentId: s.environmentId,
      issueId: s.issueId, heartbeatRunId: s.runId, providerLeaseId: randomUUID() });
    const fresh = await s.broker.acquire({ scope: s.scope, expectedGeneration: await s.broker.snapshot(s.scope),
      environmentLeaseId: newLease.id, registration: s.registration, environmentDriver: "sandbox" });
    expect(await commit(s, fresh)).toBe(true);
    expect(await commit(s, old)).toBe(false);
    expect((await db.select().from(agentTaskSessions))[0]!.providerStateLeaseId === fresh.leaseId).toBe(true);
  });

  it("bounds idle lifetime to seven days and hard lifetime to thirty days", async () => {
    const s = await seed(); const binding = await acquire(s); const start = clock.getTime();
    for (let day = 6; day <= 24; day += 6) {
      clock = new Date(start + day * 24 * 60 * 60 * 1000);
      const resumed = await s.broker.resume({ scope: s.scope, leaseId: binding.leaseId,
        generation: binding.generation, registration: s.registration });
      const touched = await s.broker.touch(s.scope, resumed);
      expect(touched.expiresAt.getTime()).toBe(Math.min(clock.getTime() + PROVIDER_STATE_IDLE_TTL_MS, start + PROVIDER_STATE_HARD_TTL_MS));
    }
    clock = new Date(start + PROVIDER_STATE_HARD_TTL_MS + 1);
    await expect(s.broker.resume({ scope: s.scope, leaseId: binding.leaseId,
      generation: binding.generation, registration: s.registration })).rejects.toMatchObject({ code: "provider_session_isolation_required" });
    await s.broker.destroy({ companyId: s.companyId, leaseId: binding.leaseId }, "expired");
    expect(s.fixture.artifacts.size).toBe(0);
  });

  it("refuses owner deletion while cleanup failed, then removes the agent without orphan state", async () => {
    const s = await seed(); const binding = await acquire(s); await commit(s, binding);
    s.fixture.setFailDestroy(true);
    await expect(agentService(db).remove(s.agentId)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(agents)).length).toBe(1);
    expect((await db.select().from(environmentLeases))[0]!.providerStateStatus).toBe("cleanup_failed");
    s.fixture.setFailDestroy(false);
    await agentService(db).remove(s.agentId);
    expect(s.fixture.artifacts.size).toBe(0);
    expect((await db.select().from(agentTaskSessions)).length).toBe(0);
    expect((await db.select().from(agents)).length).toBe(0);
  });

  it("guards environment deletion until the provider state has been destroyed", async () => {
    const s = await seed(); const binding = await acquire(s);
    await expect(environmentService(db).remove(s.environmentId)).rejects.toMatchObject({ status: 409 });
    expect(await environmentService(db).removeIfDeletable(s.environmentId)).toBeNull();
    await s.broker.destroy({ companyId: s.companyId, leaseId: binding.leaseId }, "reset");
    await environmentService(db).remove(s.environmentId);
    expect(s.fixture.artifacts.size).toBe(0);
    expect((await db.select().from(providerStateScopes))[0]!.currentLeaseId).toBeNull();
  });

  it("deletes a task only after destroying its state", async () => {
    const s = await seed(); const binding = await acquire(s); await commit(s, binding);
    await issueService(db).remove(s.issueId);
    expect(s.fixture.artifacts.size).toBe(0);
    expect((await db.select().from(issues)).length).toBe(0);
    expect(await commit(s, binding)).toBe(false);
  });

  it("destroys all provider state before deleting a company", async () => {
    const s = await seed(); const binding = await acquire(s); await commit(s, binding);
    await companyService(db).remove(s.companyId);
    expect(s.fixture.artifacts.size).toBe(0);
    expect((await db.select().from(companies)).length).toBe(0);
    expect((await db.select().from(environmentLeases)).length).toBe(0);
    expect((await db.select().from(agentTaskSessions)).length).toBe(0);
    expect((await db.select().from(providerStateScopes)).every((row) => row.currentLeaseId === null)).toBe(true);
  });

  it.each(["terminal", "agent", "company"] as const)("cleans state via real %s service lifecycle", async (kind) => {
    const s = await seed(); const binding = await acquire(s); await commit(s, binding);
    if (kind === "terminal") await issueService(db).update(s.issueId, { status: "cancelled" });
    if (kind === "agent") await agentService(db).terminate(s.agentId);
    if (kind === "company") await companyService(db).archive(s.companyId);
    expect(s.fixture.artifacts.size).toBe(0);
    expect(await commit(s, binding)).toBe(false);
    expect((await db.select().from(environmentLeases))[0]!.providerStateStatus).toBe("destroyed");
  });
});
