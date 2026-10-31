import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

async function seedExecutorFixture(db: Db, issueStatus: "in_progress" | "blocked" = "in_progress") {
  const companyId = randomUUID();
  const holderAgentId = randomUUID();
  const assigneeAgentId = randomUUID();
  const issueId = randomUUID();
  const holderWakeId = randomUUID();
  const holderRunId = randomUUID();
  const wakeId = randomUUID();
  const holderCreatedAt = new Date(Date.now() - 20_000);
  // The holder run left `running` without ever reaching the server's normal
  // finalization path -- a host watchdog `UPDATE` reaped it directly, which is
  // the HELA-12358 scenario this reconcile mode exists for.
  const holderFinishedAt = new Date(Date.now() - 5_000);
  const parkedAt = new Date(Date.now() - 10_000);

  await db.insert(companies).values({
    id: companyId,
    name: `Deferred Executor Wake ${companyId.slice(0, 8)}`,
    issuePrefix: `DEW${companyId.slice(0, 5).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  });
  await db.insert(agents).values([
    {
      id: holderAgentId,
      companyId,
      name: "Reaped Holder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    },
    {
      id: assigneeAgentId,
      companyId,
      name: "Current Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    },
  ]);
  await db.insert(agentWakeupRequests).values({
    id: holderWakeId,
    companyId,
    agentId: holderAgentId,
    source: "on_demand",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: { issueId },
    status: "skipped",
  });
  await db.insert(heartbeatRuns).values({
    id: holderRunId,
    companyId,
    agentId: holderAgentId,
    invocationSource: "on_demand",
    status: "failed",
    wakeupRequestId: holderWakeId,
    contextSnapshot: { issueId },
    createdAt: holderCreatedAt,
    startedAt: holderCreatedAt,
    finishedAt: holderFinishedAt,
    errorCode: "reaped_hung_run",
  });
  await db.update(agentWakeupRequests).set({ runId: holderRunId }).where(eq(agentWakeupRequests.id, holderWakeId));
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Executor wake orphaned by a holder reaped outside the server",
    status: issueStatus,
    priority: "high",
    assigneeAgentId,
  });
  await db.insert(agentWakeupRequests).values({
    id: wakeId,
    companyId,
    agentId: assigneeAgentId,
    source: "issue_blockers_resolved",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: { issueId },
    status: "deferred_issue_execution",
    requestedAt: parkedAt,
  });

  return { companyId, holderAgentId, assigneeAgentId, issueId, holderRunId, wakeId };
}

async function snapshot(db: Db, fixture: Awaited<ReturnType<typeof seedExecutorFixture>>) {
  const [wake, issue, runs, wakes] = await Promise.all([
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.wakeId)).then((rows) => rows[0]),
    db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId)),
  ]);
  return { wake, issue, runs, wakes };
}

describePostgres("deferred executor wake reconciliation (HELA-18814)", () => {
  let db!: Db;
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-executor-wake-");
    db = createDb(testDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  it("promotes the orphaned executor wake directly, without a review stage, via the service call", async () => {
    const fixture = await seedExecutorFixture(db);
    const receipt = await heartbeatService(db).reconcileDeferredReviewWake({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      wakeId: fixture.wakeId,
      expectedHolderRunId: fixture.holderRunId,
      mode: "executor",
    });
    expect(receipt).toMatchObject({ outcome: "promoted", mode: "executor", wakeId: fixture.wakeId });

    const state = await snapshot(db, fixture);
    const promoted = state.runs.find((run) => run.id === (receipt as any).runId);
    expect(promoted?.wakeupRequestId).toBe(fixture.wakeId);
    expect(promoted?.agentId).toBe(fixture.assigneeAgentId);
    expect(state.issue?.executionRunId).toBe(promoted?.id);
    expect(state.wakes).toHaveLength(2);
  });

  it("allows only the board to reconcile over HTTP (no expectedStageId selects executor mode), and repeats return the same run", async () => {
    const fixture = await seedExecutorFixture(db);
    const path = `/api/issues/${fixture.issueId}/deferred-wakes/${fixture.wakeId}/reconcile`;
    const body = { expectedHolderRunId: fixture.holderRunId };
    const board = boardActor(fixture.companyId);
    const agent = {
      type: "agent" as const,
      agentId: fixture.assigneeAgentId,
      companyId: fixture.companyId,
      runId: randomUUID(),
      source: "agent_jwt" as const,
    };

    expect((await request(createApp(db, agent)).post(path).send(body)).status).toBe(403);

    const [first, second] = await Promise.all([
      request(createApp(db, board)).post(path).send(body),
      request(createApp(db, board)).post(path).send(body),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.outcome, second.body.outcome].sort()).toEqual(["already_promoted", "promoted"]);
    expect(first.body.mode).toBe("executor");
    expect(second.body.mode).toBe("executor");
    expect(first.body.wakeId).toBe(fixture.wakeId);
    expect(first.body.runId).toBe(second.body.runId);
    expect(first.body.newWakeRequests).toBe(0);
    expect(second.body.newWakeRequests).toBe(0);

    const repeat = await request(createApp(db, board)).post(path).send(body);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ outcome: "already_promoted", mode: "executor", runId: first.body.runId });

    const state = await snapshot(db, fixture);
    expect(state.wake?.runId).toBe(first.body.runId);
    expect(state.issue?.executionRunId).toBe(first.body.runId);
    expect(state.wakes).toHaveLength(2);
  });

  it("promotes a blocked issue only once its dependencies are ready", async () => {
    const fixture = await seedExecutorFixture(db, "blocked");
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: fixture.companyId,
      title: "Open blocker",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: blockerId,
      relatedIssueId: fixture.issueId,
      type: "blocks",
    });

    const path = `/api/issues/${fixture.issueId}/deferred-wakes/${fixture.wakeId}/reconcile`;
    const body = { expectedHolderRunId: fixture.holderRunId };
    const reconcile = () => request(createApp(db, boardActor(fixture.companyId))).post(path).send(body);

    expect((await reconcile()).status).toBe(409);
    const stillParked = await snapshot(db, fixture);
    expect(stillParked.wake?.status).toBe("deferred_issue_execution");
    expect(stillParked.wake?.runId).toBeNull();

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    const resolved = await reconcile();
    expect(resolved.status).toBe(200);
    expect(resolved.body.outcome).toBe("promoted");
  });

  it("refuses an unblocked-status issue that still has an open blocker, since the promoted run would be cancelled and the wake skipped", async () => {
    const fixture = await seedExecutorFixture(db);
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: fixture.companyId,
      title: "Open blocker",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: blockerId,
      relatedIssueId: fixture.issueId,
      type: "blocks",
    });

    const path = `/api/issues/${fixture.issueId}/deferred-wakes/${fixture.wakeId}/reconcile`;
    const response = await request(createApp(db, boardActor(fixture.companyId)))
      .post(path)
      .send({ expectedHolderRunId: fixture.holderRunId });
    expect(response.status).toBe(409);

    const state = await snapshot(db, fixture);
    expect(state.issue?.status).toBe("in_progress");
    expect(state.wake?.status).toBe("deferred_issue_execution");
    expect(state.wake?.runId).toBeNull();
    expect(state.runs).toHaveLength(1);
    expect(state.wakes).toHaveLength(2);
  });

  it("rejects closed issues, locked issues, review-shaped wakes, competing runs, and subtree holds without consuming the wake", async () => {
    const fixture = await seedExecutorFixture(db);
    const path = `/api/issues/${fixture.issueId}/deferred-wakes/${fixture.wakeId}/reconcile`;
    const body = { expectedHolderRunId: fixture.holderRunId };
    const reconcile = () => request(createApp(db, boardActor(fixture.companyId))).post(path).send(body);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.issueId));
    expect((await reconcile()).status).toBe(409);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.issueId));

    await db.update(issues).set({ checkoutRunId: fixture.holderRunId }).where(eq(issues.id, fixture.issueId));
    expect((await reconcile()).status).toBe(409);
    await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, fixture.issueId));

    await db.update(agentWakeupRequests)
      .set({ payload: { issueId: fixture.issueId, _paperclipWakeContext: { wakeReason: "execution_review_requested" } } })
      .where(eq(agentWakeupRequests.id, fixture.wakeId));
    expect((await reconcile()).status).toBe(409);
    await db.update(agentWakeupRequests)
      .set({ payload: { issueId: fixture.issueId } })
      .where(eq(agentWakeupRequests.id, fixture.wakeId));

    const competingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: competingRunId,
      companyId: fixture.companyId,
      agentId: fixture.assigneeAgentId,
      invocationSource: "on_demand",
      status: "queued",
      contextSnapshot: { issueId: fixture.issueId },
    });
    expect((await reconcile()).status).toBe(409);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, competingRunId));

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.assigneeAgentId));
    expect((await reconcile()).status).toBe(409);
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.assigneeAgentId));

    await db.insert(issueTreeHolds).values({
      companyId: fixture.companyId,
      rootIssueId: fixture.issueId,
      mode: "pause",
      status: "active",
    });
    expect((await reconcile()).status).toBe(409);

    const state = await snapshot(db, fixture);
    expect(state.wake?.status).toBe("deferred_issue_execution");
    expect(state.wake?.runId).toBeNull();
    expect(state.wakes).toHaveLength(2);
  });
});
