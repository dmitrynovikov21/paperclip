import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const adapterType = "unicode_context_capture";

describePostgres("heartbeat Unicode context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let testHome: string | null = null;
  let originalHome: string | undefined;
  let originalApiUrl: string | undefined;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const capturedContexts: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-unicode-");
    db = createDb(tempDb.connectionString);
    originalHome = process.env.PAPERCLIP_HOME;
    originalApiUrl = process.env.PAPERCLIP_API_URL;
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-unicode-home-"));
    process.env.PAPERCLIP_HOME = testHome;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: adapterType,
      execute: async (ctx) => {
        capturedContexts.push(ctx.context as Record<string, unknown>);
        return { exitCode: 0, signal: null, timedOut: false, label: "Captured Unicode context" };
      },
      testEnvironment: async () => ({
        adapterType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Unicode context test",
      issuePrefix: "UNI",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Unicode capture",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 120_000);

  afterAll(async () => {
    if (db) await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    unregisterServerAdapter(adapterType);
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    if (testHome) await fs.rm(testHome, { recursive: true, force: true });
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  }, 60_000);

  it("repairs nested strings and keys on every context_snapshot insert and update", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      contextSnapshot: {
        nested: { "bad\ud83d": ["start\ud83d", "\udfe2end", "keep 🟢"] },
        recordedAt: new Date("2026-10-22T00:00:00.000Z"),
      },
    });
    const inserted = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(inserted?.contextSnapshot).toEqual({
      nested: { "bad\uFFFD": ["start\uFFFD", "\uFFFDend", "keep 🟢"] },
      recordedAt: "2026-10-22T00:00:00.000Z",
    });

    await db.update(heartbeatRuns).set({
      contextSnapshot: { recovery: { body: "before\ud83d after 🟢" } },
    }).where(eq(heartbeatRuns.id, runId));
    const updated = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(updated?.contextSnapshot).toEqual({ recovery: { body: "before\uFFFD after 🟢" } });
  });

  it("starts a stub adapter with a stored, well-formed wake from an issue hierarchy", async () => {
    const grandparentId = randomUUID();
    const parentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const annotationId = randomUUID();
    const description = `${"i".repeat(11_999)}🟢full text`;

    await db.insert(issues).values([
      {
        id: grandparentId, companyId, title: "Grandparent", status: "in_progress",
        description: `${"g".repeat(499)}🟢 ancestor`, responsibleUserId: "responsible-user",
      },
      {
        id: parentId, companyId, parentId: grandparentId, title: "Parent", status: "in_progress",
        description: `${"p".repeat(1_199)}🟢 parent`, responsibleUserId: "responsible-user",
      },
      {
        id: issueId, companyId, parentId, title: "Current issue", status: "todo",
        description, assigneeAgentId: agentId, responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "responsible-user", body: `${"c".repeat(3_999)}🟢 comment`,
    });
    const [document] = await db.insert(documents).values({
      companyId, title: "Annotation source", latestBody: "Example",
    }).returning();
    await db.insert(issueDocuments).values({
      companyId, issueId, documentId: document!.id, key: "plan",
    });
    const [thread] = await db.insert(documentAnnotationThreads).values({
      companyId, issueId, documentId: document!.id, documentKey: "plan",
      originalRevisionNumber: 1, currentRevisionNumber: 1,
      selectedText: `${"s".repeat(499)}🟢 selected`, normalizedStart: 0, normalizedEnd: 7,
      markdownStart: 0, markdownEnd: 7,
      anchorSelector: {
        quote: { exact: "Example", prefix: "", suffix: "" },
        position: { normalizedStart: 0, normalizedEnd: 7, markdownStart: 0, markdownEnd: 7 },
      },
    }).returning();
    await db.insert(documentAnnotationComments).values({
      id: annotationId, companyId, issueId, threadId: thread!.id, documentId: document!.id,
      authorType: "user", authorUserId: "responsible-user",
      body: `${"n".repeat(1_199)}🟢${"n".repeat(2_798)}🟢 annotation`,
    });

    const wakeContext = {
      issueId, wakeReason: "issue_commented", commentId, wakeCommentIds: [commentId],
      annotationCommentId: annotationId,
      nested: { damaged: "\ud83d" },
    };
    const payload = await buildPaperclipWakePayload({ db, companyId, contextSnapshot: wakeContext });
    const commentBody = payload?.comments[0]?.body as string | undefined;
    const annotationBody = payload?.annotationDeltas[0]?.body as string | undefined;
    expect(payload?.issue?.description).toBe("i".repeat(11_999));
    expect(commentBody?.length).toBe(3_999);
    expect(commentBody?.endsWith("c")).toBe(true);
    expect(annotationBody?.length).toBe(3_999);
    expect(annotationBody?.endsWith("n")).toBe(true);
    expect(payload?.planReviewContext?.threads[0]?.selectedText).toBe("s".repeat(499));
    expect(payload?.planReviewContext?.threads[0]?.comments[0]?.body).toBe("n".repeat(1_199));

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, commentId }, contextSnapshot: wakeContext,
      requestedByActorType: "system", requestedByActorId: "unicode_context_test",
    });
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const saved = await heartbeat.getRun(run!.id);
    expect(saved?.status).toBe("succeeded");
    expect(saved?.errorCode).not.toBe("setup_failed");
    expect(saved?.contextSnapshot).toMatchObject({ nested: { damaged: "\uFFFD" } });
    expect(JSON.stringify(saved?.contextSnapshot)).not.toMatch(/\\u[dD][89aAbB][0-9a-fA-F]{2}/);
    expect(capturedContexts).toHaveLength(1);
    expect((capturedContexts[0]?.paperclipIssue as { description: string }).description).toBe(description);
    const capturedWake = capturedContexts[0]?.paperclipWake as {
      issue: { description: string };
      comments: Array<{ body: string }>;
      annotationDeltas: Array<{ body: string }>;
    };
    expect(capturedWake.issue.description).toBe("i".repeat(11_999));
    expect(capturedWake.comments[0]?.body).toHaveLength(3_999);
    expect(capturedWake.annotationDeltas[0]?.body).toHaveLength(3_999);
    expect(capturedContexts[0]?.paperclipTaskMarkdown).toContain("🟢full text");
  }, 30_000);
});
