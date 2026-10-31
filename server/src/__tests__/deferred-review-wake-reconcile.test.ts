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
  issueExecutionDecisions,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { withAgentStartLock } from "../services/agent-start-lock.js";
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

async function seedReviewFixture(db: Db, holderStatus: "queued" | "cancelled") {
  const companyId = randomUUID();
  const holderAgentId = randomUUID();
  const reviewerAgentId = randomUUID();
  const issueId = randomUUID();
  const holderWakeId = randomUUID();
  const holderRunId = randomUUID();
  const wakeId = randomUUID();
  const stageId = randomUUID();
  const holderCreatedAt = new Date(Date.now() - 20_000);
  const parkedAt = new Date(Date.now() - 10_000);
  const participant = { type: "agent" as const, agentId: reviewerAgentId, userId: null };
  const returnAssignee = { type: "agent" as const, agentId: holderAgentId, userId: null };
  const executionStage = {
    wakeRole: "reviewer",
    stageId,
    stageType: "review",
    currentParticipant: participant,
    returnAssignee,
    reviewRequest: null,
    lastDecisionOutcome: null,
    allowedActions: ["approve", "request_changes"],
  };
  const executionState = {
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: participant,
    returnAssignee,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };
  const executionPolicy = { mode: "normal", commentRequired: true, stages: [] };

  await db.insert(companies).values({
    id: companyId,
    name: `Deferred Wake ${companyId.slice(0, 8)}`,
    issuePrefix: `DW${companyId.slice(0, 5).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  });
  await db.insert(agents).values([
    {
      id: holderAgentId,
      companyId,
      name: "Previous Holder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    },
    {
      id: reviewerAgentId,
      companyId,
      name: "Current Reviewer",
      role: "reviewer",
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
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_assigned",
    payload: { issueId },
    status: holderStatus === "queued" ? "queued" : "skipped",
    runId: holderRunId,
  });
  await db.insert(heartbeatRuns).values({
    id: holderRunId,
    companyId,
    agentId: holderAgentId,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: holderStatus,
    wakeupRequestId: holderWakeId,
    contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    createdAt: holderCreatedAt,
    ...(holderStatus === "cancelled" ? { finishedAt: new Date(Date.now() - 5_000), errorCode: "issue_assignee_changed" } : {}),
  });
  // Occupy the reviewer's only slot so the promoted run stays queued while
  // the test verifies its identity and linkage.
  await db.insert(heartbeatRuns).values({
    id: randomUUID(),
    companyId,
    agentId: reviewerAgentId,
    invocationSource: "on_demand",
    status: "running",
    contextSnapshot: {},
    startedAt: new Date(),
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Reviewer wake parked behind stale holder",
    status: "in_review",
    priority: "high",
    assigneeAgentId: reviewerAgentId,
    executionRunId: holderStatus === "queued" ? holderRunId : null,
    executionState,
    executionPolicy,
  });
  await db.insert(agentWakeupRequests).values({
    id: wakeId,
    companyId,
    agentId: reviewerAgentId,
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_execution_deferred",
    payload: {
      issueId,
      executionStage,
      _paperclipWakeContext: {
        issueId,
        taskId: issueId,
        wakeReason: "execution_review_requested",
        source: "issue.execution_stage",
        executionStage,
      },
    },
    status: "deferred_issue_execution",
    requestedAt: parkedAt,
  });

  return { companyId, holderAgentId, reviewerAgentId, issueId, holderRunId, wakeId, stageId, executionState, executionPolicy };
}

async function snapshot(db: Db, fixture: Awaited<ReturnType<typeof seedReviewFixture>>) {
  const [wake, issue, runs, wakes, decisions] = await Promise.all([
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.wakeId)).then((rows) => rows[0]),
    db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId)),
    db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId)),
  ]);
  return { wake, issue, runs, wakes, decisions };
}

describePostgres("deferred reviewer wake reconciliation", () => {
  let db!: Db;
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-review-wake-");
    db = createDb(testDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  it("promotes the same parked reviewer wake when a stale queued holder is cancelled", async () => {
    const fixture = await seedReviewFixture(db, "queued");
    await heartbeatService(db).resumeQueuedRuns();

    const state = await snapshot(db, fixture);
    const holder = state.runs.find((run) => run.id === fixture.holderRunId);
    const promoted = state.runs.find((run) => run.id === state.wake?.runId);
    expect(holder?.status).toBe("cancelled");
    expect(holder?.errorCode).toBe("issue_assignee_changed");
    expect(state.wake?.id).toBe(fixture.wakeId);
    expect(state.wake?.status).toBe("queued");
    expect(promoted?.wakeupRequestId).toBe(fixture.wakeId);
    expect(state.issue?.executionRunId).toBe(promoted?.id);
    expect(state.wakes).toHaveLength(2);
    expect(state.issue?.executionState).toEqual(fixture.executionState);
    expect(state.issue?.executionPolicy).toEqual(fixture.executionPolicy);
    expect(state.decisions).toHaveLength(0);
  });

  it("allows only the board to reconcile an exact parked wake, and repeats return its run", async () => {
    const fixture = await seedReviewFixture(db, "cancelled");
    const siblingId = randomUUID();
    await db.insert(issues).values({
      id: siblingId,
      companyId: fixture.companyId,
      title: "Another issue still referencing the terminal holder",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: fixture.holderAgentId,
      executionRunId: fixture.holderRunId,
    });
    const path = `/api/issues/${fixture.issueId}/deferred-wakes/${fixture.wakeId}/reconcile`;
    const body = { expectedHolderRunId: fixture.holderRunId, expectedStageId: fixture.stageId };
    const board = boardActor(fixture.companyId);
    const agent = {
      type: "agent" as const,
      agentId: fixture.reviewerAgentId,
      companyId: fixture.companyId,
      runId: randomUUID(),
      source: "agent_jwt" as const,
    };

    expect((await request(createApp(db, agent)).post(path).send(body)).status).toBe(403);
    expect((await request(createApp(db, board)).post(path).send({ ...body, expectedStageId: randomUUID() })).status).toBe(409);

    const [first, second] = await Promise.all([
      request(createApp(db, board)).post(path).send(body),
      request(createApp(db, board)).post(path).send(body),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.outcome, second.body.outcome].sort()).toEqual(["already_promoted", "promoted"]);
    expect(first.body.wakeId).toBe(fixture.wakeId);
    expect(second.body.wakeId).toBe(fixture.wakeId);
    expect(first.body.runId).toBe(second.body.runId);
    expect(first.body.newWakeRequests).toBe(0);
    expect(second.body.newWakeRequests).toBe(0);

    const repeat = await request(createApp(db, board)).post(path).send(body);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ outcome: "already_promoted", runId: first.body.runId });

    const state = await snapshot(db, fixture);
    const promoted = state.runs.find((run) => run.id === first.body.runId);
    expect(promoted?.wakeupRequestId).toBe(fixture.wakeId);
    expect(state.wake?.runId).toBe(first.body.runId);
    expect(state.issue?.executionRunId).toBe(first.body.runId);
    expect(state.wakes).toHaveLength(2);
    expect(state.issue?.executionState).toEqual(fixture.executionState);
    expect(state.issue?.executionPolicy).toEqual(fixture.executionPolicy);
    expect(state.decisions).toHaveLength(0);
    const [sibling] = await db.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(eq(issues.id, siblingId));
    expect(sibling?.executionRunId).toBe(fixture.holderRunId);
  });

  it("rejects locks, competing runs, paused reviewers and subtree holds without consuming the wake", async () => {
    const fixture = await seedReviewFixture(db, "cancelled");
    const path = `/api/issues/${fixture.issueId}/deferred-wakes/${fixture.wakeId}/reconcile`;
    const body = { expectedHolderRunId: fixture.holderRunId, expectedStageId: fixture.stageId };
    const reconcile = () => request(createApp(db, boardActor(fixture.companyId))).post(path).send(body);

    await db.update(heartbeatRuns).set({ status: "queued", finishedAt: null })
      .where(eq(heartbeatRuns.id, fixture.holderRunId));
    expect((await reconcile()).status).toBe(409);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.holderRunId));

    await db.update(issues).set({ checkoutRunId: fixture.holderRunId }).where(eq(issues.id, fixture.issueId));
    expect((await reconcile()).status).toBe(409);
    await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, fixture.issueId));

    const competingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: competingRunId,
      companyId: fixture.companyId,
      agentId: fixture.reviewerAgentId,
      invocationSource: "on_demand",
      status: "queued",
      contextSnapshot: { issueId: fixture.issueId },
    });
    expect((await reconcile()).status).toBe(409);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, competingRunId));

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.reviewerAgentId));
    expect((await reconcile()).status).toBe(409);
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.reviewerAgentId));

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
    expect(state.issue?.executionState).toEqual(fixture.executionState);
    expect(state.wakes).toHaveLength(2);
  });

  it("returns the receipt while the reviewer's start lock is still held", async () => {
    const fixture = await seedReviewFixture(db, "cancelled");
    await withAgentStartLock(fixture.reviewerAgentId, async () => {
      const receipt = await heartbeatService(db).reconcileDeferredReviewWake({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        wakeId: fixture.wakeId,
        expectedHolderRunId: fixture.holderRunId,
        mode: "review",
        expectedStageId: fixture.stageId,
      });
      expect(receipt).toMatchObject({ outcome: "promoted", wakeId: fixture.wakeId });
    });
    const state = await snapshot(db, fixture);
    expect(state.wake?.runId).not.toBeNull();
  }, 5_000);
});
