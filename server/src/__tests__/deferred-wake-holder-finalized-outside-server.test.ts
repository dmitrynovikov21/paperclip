import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Holder finalized outside the server test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const WATCHDOG_ERROR = "reaped hung run (>240min) by watchdog";

// Parks the next adapter execution until the test releases it, so the test can
// change the run row underneath a live execution the way the host watchdog does.
function holdNextAdapterRun() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    mockAdapterExecute.mockImplementationOnce(async () => {
      resolve();
      await released;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Held adapter run released.",
        provider: "test",
        model: "test-model",
      };
    });
  });
  return { started, release };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]);
}

async function waitForValue<T>(read: () => Promise<T | null | undefined>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return read();
}

async function seedCompany(db: Db) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `Holder Outside Server ${companyId.slice(0, 8)}`,
    issuePrefix: `HOS${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Current Assignee",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    permissions: {},
  });
  return { companyId, agentId };
}

// The executor wake that arrived while the holder ran, in the shape
// enqueueWakeup parks it behind a live execution lock.
async function parkDeferredWake(db: Db, input: { companyId: string; agentId: string; issueId: string; requestedAt?: Date }) {
  const wakeId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeId,
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_execution_deferred",
    payload: {
      issueId: input.issueId,
      _paperclipWakeContext: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: "issue_blockers_resolved",
      },
    },
    status: "deferred_issue_execution",
    ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
  });
  return wakeId;
}

async function addLiveBlocker(db: Db, input: { companyId: string; issueId: string }) {
  const blockerId = randomUUID();
  await db.insert(issues).values({
    id: blockerId,
    companyId: input.companyId,
    title: "Open blocker",
    status: "in_progress",
    priority: "medium",
  });
  await db.insert(issueRelations).values({
    companyId: input.companyId,
    issueId: blockerId,
    relatedIssueId: input.issueId,
    type: "blocks",
  });
  await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, input.issueId));
  return blockerId;
}

// A holder that the watchdog already moved to `failed` while its wake is still
// `claimed` and the issue locks still point at it (the HELA-12358 state).
async function seedReapedHolder(db: Db) {
  const { companyId, agentId } = await seedCompany(db);
  const issueId = randomUUID();
  const holderWakeId = randomUUID();
  const holderRunId = randomUUID();
  const holderCreatedAt = new Date(Date.now() - 60_000);
  const holderFinishedAt = new Date(Date.now() - 5_000);
  await db.insert(agentWakeupRequests).values({
    id: holderWakeId,
    companyId,
    agentId,
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_assigned",
    payload: { issueId },
    status: "claimed",
    claimedAt: holderCreatedAt,
  });
  await db.insert(heartbeatRuns).values({
    id: holderRunId,
    companyId,
    agentId,
    invocationSource: "assignment",
    status: "failed",
    wakeupRequestId: holderWakeId,
    contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    createdAt: holderCreatedAt,
    startedAt: holderCreatedAt,
    finishedAt: holderFinishedAt,
    error: WATCHDOG_ERROR,
  });
  await db.update(agentWakeupRequests).set({ runId: holderRunId }).where(eq(agentWakeupRequests.id, holderWakeId));
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Executor wake behind a holder reaped outside the server",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: agentId,
    executionRunId: holderRunId,
    executionLockedAt: holderCreatedAt,
    checkoutRunId: holderRunId,
  });
  const wakeId = await parkDeferredWake(db, {
    companyId,
    agentId,
    issueId,
    requestedAt: new Date(Date.now() - 30_000),
  });
  return { companyId, agentId, issueId, holderWakeId, holderRunId, holderFinishedAt, wakeId };
}

async function readState(db: Db, input: { companyId: string; issueId: string; wakeId: string; holderWakeId: string }) {
  const [wake, holderWake, issue, runs, wakes] = await Promise.all([
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.wakeId)).then((rows) => rows[0]),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.holderWakeId)).then((rows) => rows[0]),
    db.select().from(issues).where(eq(issues.id, input.issueId)).then((rows) => rows[0]),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.companyId)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId)),
  ]);
  return { wake, holderWake, issue, runs, wakes };
}

function expectPromotedSameWake(state: Awaited<ReturnType<typeof readState>>, wakeId: string) {
  expect(state.wake?.reason).toBe("issue_execution_promoted");
  expect(state.wake?.runId).toBeTruthy();
  const promotedRun = state.runs.find((run) => run.id === state.wake?.runId);
  expect(promotedRun?.wakeupRequestId).toBe(wakeId);
  expect(state.issue?.executionRunId).toBe(promotedRun?.id);
  return promotedRun!;
}

describePostgres("deferred wake behind a holder finalized outside the server (HELA-18814)", () => {
  let db!: Db;
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("paperclip-holder-finalized-outside-");
    db = createDb(testDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  // Runs the promoted wake's own follow-ups start in the background; let every
  // queued/running run settle before the next test or the database teardown.
  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100 && idlePolls < 3; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      idlePolls = active.length === 0 ? idlePolls + 1 : 0;
      await Promise.all(active.map((run) => heartbeat.waitForRunExecutionDrain(run.id)));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  async function startHolder(heartbeat: ReturnType<typeof heartbeatService>, input: { companyId: string; agentId: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Executor wake behind a holder reaped outside the server",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
    });
    const holder = holdNextAdapterRun();
    const holderRun = await heartbeat.wakeup(input.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    expect(holderRun).not.toBeNull();
    await within(holder.started, "holder adapter start");
    const lockedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(lockedIssue?.executionRunId).toBe(holderRun!.id);
    const holderWakeId = holderRun!.wakeupRequestId!;
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, holderWakeId)).then((rows) => rows[0]?.status),
    ).toBe("claimed");
    return { issueId, holderRunId: holderRun!.id, holderWakeId, releaseHolder: holder.release };
  }

  async function reapLikeWatchdog(holderRunId: string) {
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date(), error: WATCHDOG_ERROR })
      .where(eq(heartbeatRuns.id, holderRunId));
  }

  it("late finalization closes the reaped holder's claimed wake and promotes the same deferred wake", async () => {
    const heartbeat = heartbeatService(db);
    const { companyId, agentId } = await seedCompany(db);
    const { issueId, holderRunId, holderWakeId, releaseHolder } = await startHolder(heartbeat, { companyId, agentId });
    const wakeId = await parkDeferredWake(db, { companyId, agentId, issueId });
    await reapLikeWatchdog(holderRunId);

    const promotedAdapter = holdNextAdapterRun();
    releaseHolder();
    await waitForValue(async () => {
      const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then((rows) => rows[0]);
      return wake?.runId ? wake : null;
    });
    await within(promotedAdapter.started, "promoted adapter start");

    const state = await readState(db, { companyId, issueId, wakeId, holderWakeId });
    const holderRun = state.runs.find((run) => run.id === holderRunId);
    expect(holderRun).toMatchObject({ status: "failed", error: WATCHDOG_ERROR });
    expect(state.holderWake).toMatchObject({ status: "failed", runId: holderRunId, error: WATCHDOG_ERROR });
    expect(state.holderWake?.finishedAt).toBeTruthy();
    const promotedRun = expectPromotedSameWake(state, wakeId);
    expect(promotedRun.agentId).toBe(agentId);
    expect(state.wakes).toHaveLength(2);
    expect(state.runs).toHaveLength(2);

    // The backstop sweep afterwards finds nothing left to repair.
    await heartbeat.sweepStaleIssueLocks();
    const repeat = await readState(db, { companyId, issueId, wakeId, holderWakeId });
    expect(repeat.holderWake?.updatedAt).toEqual(state.holderWake?.updatedAt);
    expect(repeat.wake?.runId).toBe(promotedRun.id);
    expect(repeat.wakes).toHaveLength(2);
    expect(repeat.runs).toHaveLength(2);

    promotedAdapter.release();
    await heartbeat.waitForRunExecutionDrain(promotedRun.id);
    await heartbeat.waitForRunExecutionDrain(holderRunId);
  }, 30_000);

  it("the sweep closes the reaped holder's claimed wake, promotes the same deferred wake, and repeats as a no-op", async () => {
    const heartbeat = heartbeatService(db);
    const fixture = await seedReapedHolder(db);
    const promotedAdapter = holdNextAdapterRun();

    await heartbeat.sweepStaleIssueLocks();
    await within(promotedAdapter.started, "promoted adapter start");

    const state = await readState(db, fixture);
    expect(state.holderWake).toMatchObject({ status: "failed", runId: fixture.holderRunId, error: WATCHDOG_ERROR });
    expect(state.holderWake?.finishedAt?.getTime()).toBe(fixture.holderFinishedAt.getTime());
    const promotedRun = expectPromotedSameWake(state, fixture.wakeId);
    expect(state.issue?.checkoutRunId).not.toBe(fixture.holderRunId);
    expect(state.wakes).toHaveLength(2);
    expect(state.runs).toHaveLength(2);

    await heartbeat.sweepStaleIssueLocks();
    const repeat = await readState(db, fixture);
    expect(repeat.holderWake?.updatedAt).toEqual(state.holderWake?.updatedAt);
    expect(repeat.wake?.runId).toBe(promotedRun.id);
    expect(repeat.issue?.executionRunId).toBe(promotedRun.id);
    expect(repeat.wakes).toHaveLength(2);
    expect(repeat.runs).toHaveLength(2);

    promotedAdapter.release();
    await heartbeat.waitForRunExecutionDrain(promotedRun.id);
  }, 30_000);

  it("the sweep keeps the deferred wake parked behind a live blocker, then the board promotes the same wake once it resolves", async () => {
    const heartbeat = heartbeatService(db);
    const fixture = await seedReapedHolder(db);
    const blockerId = await addLiveBlocker(db, fixture);

    await heartbeat.sweepStaleIssueLocks();

    const held = await readState(db, fixture);
    expect(held.wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(held.holderWake).toMatchObject({ status: "failed", runId: fixture.holderRunId });
    expect(held.issue).toMatchObject({ status: "blocked", executionRunId: null, checkoutRunId: null });
    expect(held.runs).toHaveLength(1);
    expect(held.wakes).toHaveLength(2);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    const promotedAdapter = holdNextAdapterRun();
    const receipt = await heartbeat.reconcileDeferredReviewWake({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      wakeId: fixture.wakeId,
      expectedHolderRunId: fixture.holderRunId,
      mode: "executor",
    });
    expect(receipt).toMatchObject({ outcome: "promoted", mode: "executor", wakeId: fixture.wakeId, newWakeRequests: 0 });
    await within(promotedAdapter.started, "promoted adapter start");

    const state = await readState(db, fixture);
    const promotedRun = expectPromotedSameWake(state, fixture.wakeId);
    expect(promotedRun.id).toBe((receipt as { runId: string }).runId);
    expect(state.wakes).toHaveLength(2);
    expect(state.runs).toHaveLength(2);

    promotedAdapter.release();
    await heartbeat.waitForRunExecutionDrain(promotedRun.id);
  }, 30_000);

  it("a wake held by the sweep behind a live blocker is promoted by the holder's late finalization after the blocker resolves", async () => {
    const heartbeat = heartbeatService(db);
    const { companyId, agentId } = await seedCompany(db);
    const { issueId, holderRunId, holderWakeId, releaseHolder } = await startHolder(heartbeat, { companyId, agentId });
    const wakeId = await parkDeferredWake(db, { companyId, agentId, issueId });
    const blockerId = await addLiveBlocker(db, { companyId, issueId });
    await reapLikeWatchdog(holderRunId);

    await heartbeat.sweepStaleIssueLocks();
    const held = await readState(db, { companyId, issueId, wakeId, holderWakeId });
    expect(held.wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(held.holderWake).toMatchObject({ status: "failed", runId: holderRunId, error: WATCHDOG_ERROR });
    expect(held.issue).toMatchObject({ executionRunId: null, checkoutRunId: null });
    expect(held.runs).toHaveLength(1);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    const promotedAdapter = holdNextAdapterRun();
    releaseHolder();
    await waitForValue(async () => {
      const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then((rows) => rows[0]);
      return wake?.runId ? wake : null;
    });
    await within(promotedAdapter.started, "promoted adapter start");

    const state = await readState(db, { companyId, issueId, wakeId, holderWakeId });
    expect(state.runs.find((run) => run.id === holderRunId)).toMatchObject({ status: "failed", error: WATCHDOG_ERROR });
    expect(state.holderWake?.updatedAt).toEqual(held.holderWake?.updatedAt);
    const promotedRun = expectPromotedSameWake(state, wakeId);
    expect(state.wakes).toHaveLength(2);
    expect(state.runs).toHaveLength(2);

    promotedAdapter.release();
    await heartbeat.waitForRunExecutionDrain(promotedRun.id);
    await heartbeat.waitForRunExecutionDrain(holderRunId);
  }, 30_000);
});
