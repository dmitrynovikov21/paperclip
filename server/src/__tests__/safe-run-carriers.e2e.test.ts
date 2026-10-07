import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions, agentWakeupRequests, agents, companies, createDb, feedbackExports, heartbeatRunEvents, heartbeatRuns, issueComments, issues, workspaceRuntimeServices,
} from "@paperclipai/db";
import { sessionCodec as piSessionCodec } from "@paperclipai/adapter-pi-local/server";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.ts";
import { agentRoutes } from "../routes/agents.ts";
import { issueRoutes } from "../routes/issues.ts";
import { secretRoutes } from "../routes/secrets.ts";
import { feedbackService } from "../services/feedback.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { projectSafeRunRow } from "../services/safe-run-carriers.ts";
import { secretService } from "../services/secrets.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const ADAPTER_TYPE = "safe_carrier_probe";

function markerCount(value: unknown, marker: string): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.split(marker).length - 1;
}

describeDb("safe central run carriers and feedback export", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let logDir: string;
  let previousLogPath: string | undefined;
  let previousSecretKeyFile: string | undefined;
  let db: ReturnType<typeof createDb>;
  // Hex-only markers also fit a real Hermes-style session ID suffix.
  const promptMarker = randomBytes(8).toString("hex");
  const toolMarker = randomBytes(8).toString("hex");
  const dirtySources: string[] = [];
  const runtimeServiceId = randomUUID();
  let failWithMarkers = false;
  let returnedSessionId: string | null = null;
  let returnedSessionDisplayId: string | null = null;
  let onAdapterExecute: ((runId: string) => Promise<void>) | null = null;
  let reportRuntimeService = false;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("safe-run-carriers-");
    db = createDb(tempDb.connectionString);
    logDir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "safe-run-carriers-logs-"));
    previousLogPath = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = logDir;
    previousSecretKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(logDir, "synthetic-master.key");
    registerServerAdapter({
      type: ADAPTER_TYPE,
      execute: async (ctx) => {
        if (failWithMarkers) throw new Error(`Adapter failure: ${promptMarker} ${toolMarker}`);
        dirtySources.push(promptMarker, toolMarker, returnedSessionId ?? "", returnedSessionDisplayId ?? "");
        await ctx.onMeta({ adapterType: ADAPTER_TYPE, command: "probe", prompt: promptMarker });
        await ctx.onRuntimeProgress?.({ phase: "adapter_startup", message: promptMarker, lastAssistantSnippet: toolMarker });
        await ctx.onEvent({ eventType: "tool.output", message: toolMarker, payload: { output: returnedSessionId ?? toolMarker } });
        await ctx.onLog("stdout", `${promptMarker} ${returnedSessionId ?? ""}\n`);
        await ctx.onLog("stderr", `${toolMarker} ${returnedSessionDisplayId ?? ""}\n`);
        await onAdapterExecute?.(ctx.runId);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          usage: { inputTokens: 17, outputTokens: 9 },
          usageBasis: "per_run",
          ...(returnedSessionId ? { sessionId: returnedSessionId } : {}),
          ...(returnedSessionDisplayId ? { sessionDisplayId: returnedSessionDisplayId } : {}),
          summary: toolMarker,
          resultJson: {
            summary: promptMarker, stdout: toolMarker, costUsd: 0.025,
            sessionId: returnedSessionId, session_id: returnedSessionDisplayId,
          },
          runtimeServices: reportRuntimeService ? [{ id: runtimeServiceId, serviceName: "synthetic-preview", status: "stopped" }] : undefined,
        };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER_TYPE, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER_TYPE);
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
    await rm(logDir, { recursive: true, force: true });
    if (previousLogPath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousLogPath;
    if (previousSecretKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousSecretKeyFile;
  });

  it("drops two unknown markers on write and legacy read while preserving status, usage and exit", async () => {
    returnedSessionId = `20261007_123456_${promptMarker}`;
    returnedSessionDisplayId = `20261007_123456_${toolMarker}`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Safe carrier test",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Probe",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {
      wakeReason: promptMarker,
      untrustedPrompt: promptMarker,
      toolOutput: { body: toolMarker },
    }, "manual");
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const run = await heartbeat.getRun(queued!.id);
    expect(run?.status).toBe("succeeded");
    expect(run?.exitCode).toBe(0);
    expect(run?.usageJson).toMatchObject({ inputTokens: 17, outputTokens: 9 });
    expect(run?.resultJson).toMatchObject({ costUsd: 0.025 });
    expect(dirtySources.join(" ")).toContain(promptMarker);
    expect(dirtySources.join(" ")).toContain(toolMarker);

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id));
    const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const storedLog = await getRunLogStore().read({ store: "local_file", logRef: run!.logRef! });
    const stored = { run, storedRun, events, storedLog };
    for (const marker of [promptMarker, toolMarker]) expect(markerCount(stored, marker)).toBe(0);

    failWithMarkers = true;
    const failed = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(failed).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed!.id));
    const [failedWakeup] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, failedRun!.wakeupRequestId!));
    expect(failedRun?.status).toBe("failed");
    expect(failedWakeup?.status).toBe("failed");
    expect(failedWakeup?.error).toBe("Run failed");
    for (const marker of [promptMarker, toolMarker]) {
      expect(markerCount({ failedRun, failedWakeup }, marker)).toBe(0);
    }

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feedback source",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: run!.id,
      body: toolMarker,
    });
    const uploadTraceBundle = vi.fn().mockResolvedValue({ objectKey: "feedback-traces/test.json" });
    const feedback = feedbackService(db, { shareClient: { uploadTraceBundle } });
    const saved = await feedback.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "down",
      reason: promptMarker,
      authorUserId: "user-1",
      allowSharing: true,
    });
    expect(saved.vote.reason).toBe(promptMarker); // Positive dirty-source control.

    // A legacy row can still contain content. Every read/export boundary must
    // construct a fresh safe projection instead of trusting stored snapshots.
    await db.update(heartbeatRuns).set({
      error: promptMarker,
      contextSnapshot: {
        issueId,
        wakeReason: promptMarker,
        reviewPathConsumedRef: promptMarker,
        activeTreeHold: { rootIssueId: issueId, mode: "pause", interaction: true, reason: toolMarker },
        paperclipWake: { issue: { description: promptMarker }, toolOutput: toolMarker },
        paperclipSecrets: { manifest: [{ bindingId: randomUUID() }] },
      },
      signal: promptMarker,
      nextAction: toolMarker,
      livenessReason: promptMarker,
      resultJson: { summary: promptMarker, stdout: toolMarker, inputTokens: 17 },
      sessionIdBefore: returnedSessionId,
      sessionIdAfter: returnedSessionDisplayId,
    }).where(eq(heartbeatRuns.id, run!.id));
    await db.update(heartbeatRunEvents).set({ message: toolMarker, stream: promptMarker, level: toolMarker, payload: { output: promptMarker } })
      .where(eq(heartbeatRunEvents.runId, run!.id));
    await getRunLogStore().append({ store: "local_file", logRef: run!.logRef! }, {
      stream: "stdout", chunk: toolMarker, ts: new Date().toISOString(),
    });
    await db.update(feedbackExports).set({
      payloadSnapshot: {
        target: { createdByRunId: run!.id, body: promptMarker },
        bundle: { primaryContent: { body: toolMarker }, rawAdapterTrace: promptMarker },
      },
      failureReason: toolMarker,
    }).where(eq(feedbackExports.id, saved.traceId!));

    const legacy = await heartbeat.getRun(run!.id);
    const safeRead = projectSafeRunRow(legacy!);
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "test-board",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const runResponse = await request(app).get(`/api/heartbeat-runs/${run!.id}`);
    expect(runResponse.status).toBe(200);
    expect(runResponse.body).toMatchObject({ status: "succeeded", contextSnapshot: { issueId } });
    expect(runResponse.body.contextSnapshot).not.toHaveProperty("paperclipSecrets");
    const safeEvents = await heartbeat.listEvents(run!.id);
    const safeLog = await heartbeat.readLog(run!.id);
    const traces = await feedback.listFeedbackTraces({ companyId, issueId, includePayload: true });
    const bundle = await feedback.getFeedbackTraceBundle(saved.traceId!);
    await feedback.flushPendingFeedbackTraces({ companyId, traceId: saved.traceId!, limit: 1 });
    expect(uploadTraceBundle).toHaveBeenCalledTimes(1);
    expect(bundle?.captureStatus).toBe("partial");
    expect(bundle?.rawAdapterTrace).toBeNull();
    expect(safeRead).toMatchObject({ status: "succeeded", exitCode: 0, contextSnapshot: { issueId } });
    expect(safeRead.usageJson).toMatchObject({ inputTokens: 17, outputTokens: 9 });
    for (const marker of [promptMarker, toolMarker]) {
      expect(markerCount({ safeRead, runApi: runResponse.body, safeEvents, safeLog, traces, bundle, upload: uploadTraceBundle.mock.calls[0]?.[0] }, marker)).toBe(0);
    }
    returnedSessionId = null;
    returnedSessionDisplayId = null;
  }, 60_000);

  it("omits arbitrary provider session IDs on write and hides legacy IDs in run APIs", async () => {
    failWithMarkers = false;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const canonicalSessionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Safe session ID test",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Session ID probe",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    try {
      returnedSessionId = `20261007_123456_${promptMarker}`;
      returnedSessionDisplayId = `20261007_123456_${toolMarker}`;
      const first = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(first).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [firstStored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      expect(firstStored?.status).toBe("succeeded");
      expect(firstStored?.sessionIdAfter).toBeNull();
      expect(firstStored?.sessionCorrelationId).toMatch(/^[0-9a-f-]{36}$/);
      for (const marker of [promptMarker, toolMarker]) expect(markerCount(firstStored, marker)).toBe(0);

      returnedSessionId = canonicalSessionId;
      returnedSessionDisplayId = canonicalSessionId;
      const second = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(second).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [secondStored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second!.id));
      expect(secondStored?.status).toBe("succeeded");
      expect(secondStored?.sessionIdBefore).toBeNull();
      expect(secondStored?.sessionIdAfter).toBeNull();
      expect(secondStored?.sessionCorrelationId).not.toBe(firstStored?.sessionCorrelationId);
      for (const marker of [promptMarker, toolMarker]) expect(markerCount(secondStored, marker)).toBe(0);

      // Simulate pre-fix rows without altering the provider's private state.
      await db.update(heartbeatRuns).set({
        sessionIdBefore: `20261007_123456_${promptMarker}`,
        sessionIdAfter: `20261007_123456_${toolMarker}`,
        resultJson: { sessionId: `20261007_123456_${promptMarker}`, session_id: canonicalSessionId },
      })
        .where(eq(heartbeatRuns.id, first!.id));
      const legacy = await heartbeat.getRun(first!.id);
      expect(legacy?.sessionIdBefore).toContain(promptMarker); // Positive dirty-source control.
      expect(projectSafeRunRow(legacy!).sessionIdBefore).toBeNull();
      expect(projectSafeRunRow(legacy!).sessionIdAfter).toBeNull();
      expect(projectSafeRunRow(legacy!).resultJson).not.toHaveProperty("sessionId");
      expect(projectSafeRunRow(legacy!).resultJson).not.toHaveProperty("session_id");

      const app = express();
      app.use((req, _res, next) => {
        req.actor = {
          type: "board", userId: "test-board", companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "operator", status: "active" }],
          isInstanceAdmin: true, source: "local_implicit",
        };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      const detail = await request(app).get(`/api/heartbeat-runs/${first!.id}`);
      const list = await request(app).get(`/api/companies/${companyId}/heartbeat-runs`);
      expect(detail.status).toBe(200);
      expect(list.status).toBe(200);
      expect(detail.body).toMatchObject({ sessionIdBefore: null, sessionIdAfter: null });
      expect(list.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first!.id, sessionIdBefore: null, sessionIdAfter: null }),
        expect.objectContaining({ id: second!.id, sessionIdAfter: null }),
      ]));
      for (const marker of [promptMarker, toolMarker]) {
        expect(markerCount({ detail: detail.body, list: list.body }, marker)).toBe(0);
      }
    } finally {
      returnedSessionId = null;
      returnedSessionDisplayId = null;
    }
  }, 60_000);

  it("rotates a Pi path session on the second run using only a server correlation ID", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = randomUUID();
    const resumedIds: Array<string | null> = [];
    const providerPaths: string[] = [];
    registerServerAdapter({
      type: "pi_local",
      sessionCodec: piSessionCodec,
      execute: async (ctx) => {
        resumedIds.push(ctx.runtime.sessionId);
        const sessionPath = join(logDir, `pi-session-${resumedIds.length}.jsonl`);
        providerPaths.push(sessionPath);
        await ctx.onLog("stdout", sessionPath);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: sessionPath,
          sessionDisplayId: sessionPath,
          sessionParams: { sessionId: sessionPath, cwd: logDir },
          usage: { inputTokens: 17, outputTokens: 9 },
          usageBasis: "session_cumulative",
          resultJson: { sessionId: sessionPath },
        };
      },
      testEnvironment: async () => ({ adapterType: "pi_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Pi rotation test",
        issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Pi rotation probe",
        role: "engineer",
        status: "idle",
        adapterType: "pi_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: {
          wakeOnDemand: true,
          sessionCompaction: { enabled: true, maxSessionRuns: 0, maxRawInputTokens: 1, maxSessionAgeHours: 0 },
        } },
        permissions: {},
      });
      const heartbeat = heartbeatService(db);
      const first = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual");
      expect(first).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [firstRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      const [firstSession] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId));
      expect(firstRun?.status).toBe("succeeded");
      expect(firstRun?.sessionIdAfter).toBeNull();
      expect(firstRun?.sessionCorrelationId).toBe(firstSession?.sessionCorrelationId);
      expect(firstSession?.sessionParamsJson?.sessionId).toBe(providerPaths[0]); // Positive private-source control.
      expect(markerCount(firstRun, providerPaths[0]!)).toBe(0);

      const second = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual");
      expect(second).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [secondRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second!.id));
      expect(secondRun?.status).toBe("succeeded");
      expect(resumedIds).toEqual([null, null]);
      expect(secondRun?.sessionCorrelationId).not.toBe(firstRun?.sessionCorrelationId);
      expect(secondRun?.usageJson).toMatchObject({ inputTokens: 17, sessionRotated: true });
      expect(markerCount({ firstRun, secondRun }, providerPaths[0]!)).toBe(0);
      expect(markerCount({ firstRun, secondRun }, providerPaths[1]!)).toBe(0);
    } finally {
      unregisterServerAdapter("pi_local");
    }
  }, 60_000);

  it("uses the private lastRunId for cumulative usage when a legacy session has no correlation ID", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = randomUUID();
    const sessionPath = join(logDir, "pi-legacy-session.jsonl");
    const resumedIds: Array<string | null> = [];
    registerServerAdapter({
      type: "pi_local",
      sessionCodec: piSessionCodec,
      execute: async (ctx) => {
        resumedIds.push(ctx.runtime.sessionId);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: sessionPath,
          sessionDisplayId: sessionPath,
          sessionParams: { sessionId: sessionPath, cwd: logDir },
          usage: { inputTokens: resumedIds.length * 17, outputTokens: resumedIds.length * 9 },
          usageBasis: "session_cumulative",
        };
      },
      testEnvironment: async () => ({ adapterType: "pi_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Pi legacy usage test",
        issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Pi legacy usage probe",
        role: "engineer",
        status: "idle",
        adapterType: "pi_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true,
          sessionCompaction: { enabled: true, maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0 },
        } },
        permissions: {},
      });
      const heartbeat = heartbeatService(db);
      const first = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual");
      expect(first).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await db.update(heartbeatRuns).set({
        sessionCorrelationId: null,
        sessionIdAfter: sessionPath,
      }).where(eq(heartbeatRuns.id, first!.id));
      await db.update(agentTaskSessions).set({ sessionCorrelationId: null })
        .where(eq(agentTaskSessions.agentId, agentId));
      const [legacy] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      expect(legacy?.sessionIdAfter).toBe(sessionPath); // Positive dirty-source control.
      expect(projectSafeRunRow(legacy!).sessionIdAfter).toBeNull();

      const second = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual");
      expect(second).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [secondRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second!.id));
      expect(resumedIds).toEqual([null, sessionPath]);
      expect(secondRun?.sessionCorrelationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(secondRun?.usageJson).toMatchObject({ inputTokens: 17, rawInputTokens: 34 });
      expect(markerCount(secondRun, sessionPath)).toBe(0);
    } finally {
      unregisterServerAdapter("pi_local");
    }
  }, 60_000);

  it("does not delta cumulative usage across runs without a provider session", async () => {
    const adapterType = "no_session_cumulative_probe";
    const companyId = randomUUID();
    const agentId = randomUUID();
    registerServerAdapter({
      type: adapterType,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: { inputTokens: 17, outputTokens: 9 },
        usageBasis: "session_cumulative",
      }),
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    try {
      await db.insert(companies).values({
        id: companyId,
        name: "No session usage test",
        issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "No session usage probe",
        role: "engineer",
        status: "idle",
        adapterType,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      });
      const heartbeat = heartbeatService(db);
      const first = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(first).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const second = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(second).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [firstRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      const [secondRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second!.id));
      expect(firstRun?.status).toBe("succeeded");
      expect(secondRun?.status).toBe("succeeded");
      expect(firstRun?.sessionCorrelationId).toBeNull();
      expect(secondRun?.sessionCorrelationId).toBeNull();
      expect(firstRun?.usageJson).toMatchObject({ inputTokens: 17, outputTokens: 9 });
      expect(secondRun?.usageJson).toMatchObject({ inputTokens: 17, outputTokens: 9 });
    } finally {
      unregisterServerAdapter(adapterType);
    }
  }, 60_000);

  it("keeps a run-bound secret redaction after adapter runtime services refresh the snapshot", async () => {
    failWithMarkers = false;
    reportRuntimeService = true;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const secretValue = `synthetic-${randomUUID()}`;
    const commentId = randomUUID();
    let secretReadStatus = 0;
    let commentWritten = false;
    await db.insert(companies).values({
      id: companyId,
      name: "Run redaction test",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Secret reader",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Secret redaction source",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      key: "RUN_TOKEN",
      name: "Synthetic run token",
      provider: "local_encrypted",
      value: secretValue,
    });
    await secrets.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "access.RUN_TOKEN",
      projectionClass: "class_2_runtime_only",
    });

    onAdapterExecute = async (runId) => {
      const agentApp = express();
      agentApp.use(express.json());
      agentApp.use((req, _res, next) => {
        req.actor = {
          type: "agent", agentId, companyId, runId,
          keyScope: { kind: "standard" }, source: "agent_jwt",
        };
        next();
      });
      agentApp.use("/api", secretRoutes(db));
      agentApp.use(errorHandler);
      const fetched = await request(agentApp).post("/api/agents/me/secrets/run_token/value");
      secretReadStatus = fetched.status;
      if (fetched.status !== 200 || fetched.body.value !== secretValue) {
        throw new Error(`Synthetic secret read failed: ${fetched.status}`);
      }
      await db.insert(issueComments).values({
        id: commentId, companyId, issueId, authorAgentId: agentId,
        createdByRunId: runId, body: `agent comment: ${fetched.body.value}`,
      });
      commentWritten = true;
    };

    try {
      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
      expect(queued).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      expect(secretReadStatus).toBe(200);
      expect(commentWritten).toBe(true);
      const services = await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.startedByRunId, queued!.id));
      expect(services).toHaveLength(1);
      expect(storedRun?.status).toBe("succeeded");
      expect(storedRun?.contextSnapshot).toMatchObject({
        issueId,
        paperclipSecretRedactions: [expect.objectContaining({ fingerprintSha256: expect.any(String) })],
      });
      expect(markerCount(storedRun, secretValue)).toBe(0);
      const [rawComment] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
      expect(rawComment?.body).toContain(secretValue); // The source is deliberately dirty.

      const boardApp = express();
      boardApp.use((req, _res, next) => {
        req.actor = {
          type: "board", userId: "test-board", companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "operator", status: "active" }],
          isInstanceAdmin: true, source: "local_implicit",
        };
        next();
      });
      boardApp.use("/api", issueRoutes(db, {} as never));
      boardApp.use("/api", agentRoutes(db));
      boardApp.use(errorHandler);
      const comments = await request(boardApp).get(`/api/issues/${issueId}/comments`);
      const wakeContext = await request(boardApp)
        .get(`/api/issues/${issueId}/heartbeat-context`)
        .query({ wakeCommentId: commentId });
      const runApi = await request(boardApp).get(`/api/heartbeat-runs/${queued!.id}`);
      expect(comments.status).toBe(200);
      expect(wakeContext.status).toBe(200);
      expect(runApi.status).toBe(200);
      expect(markerCount({ comments: comments.body, wakeContext: wakeContext.body, runApi: runApi.body }, secretValue)).toBe(0);
      expect(comments.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: commentId, body: "agent comment: ***REDACTED***" }),
      ]));
      expect(runApi.body.contextSnapshot).not.toHaveProperty("paperclipSecretRedactions");
    } finally {
      onAdapterExecute = null;
      reportRuntimeService = false;
    }
  }, 60_000);
});
