import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueExecutionAttestationRoutes } from "../routes/issue-execution-attestation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution attestation route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

const REPO = "acme-print/backend";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueExecutionAttestationRoutes(db));
  app.use(errorHandler);
  return app;
}

function viewerBoardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "attestation-viewer",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "viewer", status: "active" }],
    isInstanceAdmin: false,
    source: "board_key",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId: randomUUID(),
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label: string) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `EA${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  await db.insert(companyMemberships).values({
    companyId: company!.id,
    principalType: "user",
    principalId: "attestation-viewer",
    status: "active",
    membershipRole: "viewer",
  });
  return company!;
}

async function seedAgent(db: Db, companyId: string, name: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `${name} ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    identifier: string;
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
    executionPolicy?: Record<string, unknown> | null;
    executionState?: Record<string, unknown> | null;
    createdAt?: Date;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    identifier: input.identifier,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    responsibleUserId: "board-user",
    executionPolicy: input.executionPolicy ?? null,
    executionState: input.executionState ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }).returning();
  return issue!;
}

async function seedPullRequest(
  db: Db,
  input: { companyId: string; issueId: string; externalId?: string | null; url?: string | null; type?: string; provider?: string },
) {
  await db.insert(issueWorkProducts).values({
    companyId: input.companyId,
    issueId: input.issueId,
    type: input.type ?? "pull_request",
    provider: input.provider ?? "github",
    externalId: input.externalId ?? null,
    url: input.url ?? null,
    title: "PR",
    status: "ready_for_review",
  });
}

async function seedDecision(
  db: Db,
  input: { companyId: string; issueId: string; stageId: string; actorAgentId: string; outcome: string; body: string; at: Date },
) {
  const [decision] = await db.insert(issueExecutionDecisions).values({
    companyId: input.companyId,
    issueId: input.issueId,
    stageId: input.stageId,
    stageType: "review",
    actorAgentId: input.actorAgentId,
    outcome: input.outcome,
    body: input.body,
    createdAt: input.at,
    updatedAt: input.at,
  }).returning();
  return decision!;
}

function verdictBody(pr: number, sha: string) {
  return `Approved.\n\nReviewed-PR: ${REPO}#${pr}\nReviewed-Head-SHA: ${sha}`;
}

async function seedReviewedIssue(db: Db, company: CompanyRow, identifier: string) {
  const executor = await seedAgent(db, company.id, "Executor");
  const reviewerA = await seedAgent(db, company.id, "Reviewer A");
  const reviewerB = await seedAgent(db, company.id, "Reviewer B");
  const stageA = randomUUID();
  const stageB = randomUUID();
  const executionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [
      { id: stageA, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerA.id, userId: null }] },
      { id: stageB, type: "approval", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerB.id, userId: null }] },
    ],
    monitor: {
      nextCheckAt: "2026-09-25T00:00:00.000Z",
      notes: "monitor notes stay out of the projection",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "github",
      externalRef: "[redacted]",
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: null,
    },
  };
  const executionState = {
    status: "completed",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: { type: "agent", agentId: executor.id, userId: null },
    reviewRequest: { instructions: "review-request text stays out of the projection" },
    completedStageIds: [stageA, stageB],
    lastDecisionId: null,
    lastDecisionOutcome: "approved",
    monitor: null,
  };
  const issue = await seedIssue(db, {
    companyId: company.id,
    identifier,
    title: "Review card",
    status: "done",
    assigneeAgentId: reviewerB.id,
    executionPolicy,
    executionState,
  });
  // Inserted out of chronological order: the projection must sort by createdAt, not by heap order.
  const approvedB = await seedDecision(db, {
    companyId: company.id, issueId: issue.id, stageId: stageB, actorAgentId: reviewerB.id,
    outcome: "approved", body: verdictBody(1151, HEAD_SHA), at: new Date("2026-09-24T05:20:00.000Z"),
  });
  const approvedA = await seedDecision(db, {
    companyId: company.id, issueId: issue.id, stageId: stageA, actorAgentId: reviewerA.id,
    outcome: "approved", body: verdictBody(1151, HEAD_SHA), at: new Date("2026-09-24T05:00:00.000Z"),
  });
  const changesB = await seedDecision(db, {
    companyId: company.id, issueId: issue.id, stageId: stageB, actorAgentId: reviewerB.id,
    outcome: "changes_requested", body: "Needs a test.", at: new Date("2026-09-24T05:10:00.000Z"),
  });
  return { issue, executor, reviewerA, reviewerB, stageA, stageB, decisions: [approvedA, changesB, approvedB] };
}

describeEmbeddedPostgres("issue execution attestation routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-attestation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("projects stages, state and every decision in order, by id and by identifier", async () => {
    const company = await seedCompany(db, "Attestation");
    const fixture = await seedReviewedIssue(db, company, "EAT-1");
    await seedPullRequest(db, { companyId: company.id, issueId: fixture.issue.id, externalId: `${REPO}#1151` });
    await seedPullRequest(db, { companyId: company.id, issueId: fixture.issue.id, type: "branch", url: `https://github.com/${REPO}/pull/1151` });
    await seedPullRequest(db, { companyId: company.id, issueId: fixture.issue.id, type: "artifact", provider: "paperclip" });
    const other = await seedIssue(db, { companyId: company.id, identifier: "EAT-2", title: "Other card" });
    await seedDecision(db, {
      companyId: company.id, issueId: other.id, stageId: randomUUID(), actorAgentId: fixture.reviewerA.id,
      outcome: "approved", body: "other card", at: new Date("2026-09-24T05:05:00.000Z"),
    });

    const app = createApp(db, viewerBoardActor(company));
    const byId = await request(app).get(`/api/issues/${fixture.issue.id}/execution-attestation`);
    expect(byId.status).toBe(200);
    expect(byId.body.schemaVersion).toBe(1);
    expect(byId.body.issue).toMatchObject({ id: fixture.issue.id, identifier: "EAT-1", companyId: company.id, status: "done" });
    expect(byId.body.executionPolicy.valid).toBe(true);
    expect(byId.body.executionPolicy.stages).toEqual([
      { id: fixture.stageA, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: fixture.reviewerA.id, userId: null }] },
      { id: fixture.stageB, type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: fixture.reviewerB.id, userId: null }] },
    ]);
    expect(byId.body.executionState).toMatchObject({
      valid: true,
      status: "completed",
      completedStageIds: [fixture.stageA, fixture.stageB],
      lastDecisionOutcome: "approved",
      returnAssignee: { type: "agent", agentId: fixture.executor.id, userId: null },
    });
    expect(JSON.stringify(byId.body)).not.toContain("monitor notes stay out");
    expect(JSON.stringify(byId.body)).not.toContain("review-request text stays out");
    expect(byId.body.decisions.map((decision: { id: string }) => decision.id)).toEqual(fixture.decisions.map((decision) => decision.id));
    expect(byId.body.decisions.map((decision: { outcome: string }) => decision.outcome)).toEqual(["approved", "changes_requested", "approved"]);
    expect(byId.body.decisions[2]).toEqual({
      id: fixture.decisions[2].id,
      stageId: fixture.stageB,
      stageType: "review",
      outcome: "approved",
      actorAgentId: fixture.reviewerB.id,
      actorUserId: null,
      body: verdictBody(1151, HEAD_SHA),
      createdAt: "2026-09-24T05:20:00.000Z",
    });
    expect(byId.body.githubPullRequests).toHaveLength(1);
    expect(byId.body.githubPullRequests[0]).toMatchObject({ externalId: `${REPO}#1151`, repo: REPO, number: 1151 });

    const byIdentifier = await request(app).get("/api/issues/eat-1/execution-attestation");
    expect(byIdentifier.status).toBe(200);
    expect(byIdentifier.body.issue.id).toBe(fixture.issue.id);
    expect(byIdentifier.body.decisions).toHaveLength(3);
  });

  it("marks a stored policy whose stage has no id as invalid instead of inventing one", async () => {
    const company = await seedCompany(db, "Attestation invalid");
    const reviewer = await seedAgent(db, company.id, "Reviewer");
    const issue = await seedIssue(db, {
      companyId: company.id,
      identifier: "EAT-3",
      title: "Broken policy",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] },
    });

    const res = await request(createApp(db, viewerBoardActor(company))).get(`/api/issues/${issue.id}/execution-attestation`);
    expect(res.status).toBe(200);
    expect(res.body.executionPolicy.valid).toBe(false);
    expect(res.body.executionPolicy.stages[0].id).toBeNull();
    expect(res.body.executionState).toBeNull();
    expect(res.body.decisions).toEqual([]);
  });

  it("answers 404 for unknown issues and refs that are neither UUIDs nor identifiers", async () => {
    const company = await seedCompany(db, "Attestation 404");
    const app = createApp(db, viewerBoardActor(company));
    expect((await request(app).get(`/api/issues/${randomUUID()}/execution-attestation`)).status).toBe(404);
    expect((await request(app).get("/api/issues/not-a-ref/execution-attestation")).status).toBe(404);
  });

  it("rejects missing actors and agents of another company", async () => {
    const company = await seedCompany(db, "Attestation owner");
    const stranger = await seedCompany(db, "Attestation stranger");
    const strangerAgent = await seedAgent(db, stranger.id, "Stranger");
    const ownAgent = await seedAgent(db, company.id, "Own");
    const fixture = await seedReviewedIssue(db, company, "EAT-4");

    const anonymous = createApp(db, { type: "none", source: "none" } as Express.Request["actor"]);
    expect((await request(anonymous).get(`/api/issues/${fixture.issue.id}/execution-attestation`)).status).toBe(401);
    expect((await request(anonymous).get(`/api/companies/${company.id}/execution-attestations?repo=${REPO}&pr=1151`)).status).toBe(401);

    const foreign = createApp(db, agentActor(stranger, strangerAgent));
    expect((await request(foreign).get(`/api/issues/${fixture.issue.id}/execution-attestation`)).status).toBe(403);
    expect((await request(foreign).get(`/api/companies/${company.id}/execution-attestations?repo=${REPO}&pr=1151`)).status).toBe(403);

    const own = createApp(db, agentActor(company, ownAgent));
    expect((await request(own).get(`/api/issues/${fixture.issue.id}/execution-attestation`)).status).toBe(200);

    // The board key still lists the company, but the membership behind it is gone.
    await db.update(companyMemberships).set({ status: "suspended" });
    const revoked = createApp(db, viewerBoardActor(company));
    expect((await request(revoked).get(`/api/issues/${fixture.issue.id}/execution-attestation`)).status).toBe(403);
    expect((await request(revoked).get(`/api/companies/${company.id}/execution-attestations?repo=${REPO}&pr=1151`)).status).toBe(403);
  });

  it("finds cards linked to a pull request by external id or URL, within the company only", async () => {
    const company = await seedCompany(db, "Attestation lookup");
    const stranger = await seedCompany(db, "Attestation lookup stranger");
    const byExternalId = await seedIssue(db, {
      companyId: company.id, identifier: "EAT-10", title: "external id", createdAt: new Date("2026-09-24T01:00:00.000Z"),
    });
    const byUrl = await seedIssue(db, {
      companyId: company.id, identifier: "EAT-11", title: "url", createdAt: new Date("2026-09-24T02:00:00.000Z"),
    });
    const otherPr = await seedIssue(db, { companyId: company.id, identifier: "EAT-12", title: "other PR" });
    const branchOnly = await seedIssue(db, { companyId: company.id, identifier: "EAT-13", title: "branch work product" });
    const foreign = await seedIssue(db, { companyId: stranger.id, identifier: "EAX-1", title: "foreign" });
    await seedPullRequest(db, { companyId: company.id, issueId: byExternalId.id, externalId: ` ${REPO}#1151 ` });
    await seedPullRequest(db, { companyId: company.id, issueId: byUrl.id, url: "https://github.com/ACME-Print/BACKEND/pull/1151/" });
    await seedPullRequest(db, { companyId: company.id, issueId: otherPr.id, externalId: `${REPO}#11510` });
    await seedPullRequest(db, { companyId: company.id, issueId: branchOnly.id, type: "branch", url: `https://github.com/${REPO}/pull/1151` });
    await seedPullRequest(db, { companyId: stranger.id, issueId: foreign.id, externalId: `${REPO}#1151` });

    const app = createApp(db, viewerBoardActor(company));
    const res = await request(app).get(`/api/companies/${company.id}/execution-attestations`).query({ repo: REPO, pr: "1151" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schemaVersion: 1, repo: REPO, pullRequestNumber: 1151, truncated: false, withheld: 0 });
    expect(res.body.attestations.map((item: { issue: { identifier: string } }) => item.issue.identifier)).toEqual(["EAT-10", "EAT-11"]);
    expect(res.body.attestations[1].githubPullRequests[0]).toMatchObject({ repo: "ACME-Print/BACKEND", number: 1151 });

    const none = await request(app).get(`/api/companies/${company.id}/execution-attestations`).query({ repo: REPO, pr: "1150" });
    expect(none.status).toBe(200);
    expect(none.body.attestations).toEqual([]);
  });

  it("rejects malformed lookup queries", async () => {
    const company = await seedCompany(db, "Attestation query");
    const app = createApp(db, viewerBoardActor(company));
    for (const query of [
      { pr: "1151" },
      { repo: REPO },
      { repo: REPO, pr: "0" },
      { repo: REPO, pr: "12a" },
      { repo: REPO, pr: "-3" },
      { repo: "../etc/passwd", pr: "1" },
      { repo: "owner", pr: "1" },
      { repo: "own er/repo", pr: "1" },
    ]) {
      const res = await request(app).get(`/api/companies/${company.id}/execution-attestations`).query(query);
      expect(res.status, JSON.stringify(query)).toBe(400);
    }
  });

  it("exposes no mutating verbs on the attestation paths", async () => {
    const company = await seedCompany(db, "Attestation verbs");
    const fixture = await seedReviewedIssue(db, company, "EAT-20");
    const app = createApp(db, viewerBoardActor(company));
    for (const method of ["post", "put", "patch", "delete"] as const) {
      expect((await request(app)[method](`/api/issues/${fixture.issue.id}/execution-attestation`).send({})).status).toBe(404);
      expect((await request(app)[method](`/api/companies/${company.id}/execution-attestations`).send({})).status).toBe(404);
    }
    const decisions = await db.select().from(issueExecutionDecisions);
    expect(decisions).toHaveLength(3);
  });
});
