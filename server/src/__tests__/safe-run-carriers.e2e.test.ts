import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, feedbackExports, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.ts";
import { agentRoutes } from "../routes/agents.ts";
import { feedbackService } from "../services/feedback.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { projectSafeRunRow } from "../services/safe-run-carriers.ts";
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
  let db: ReturnType<typeof createDb>;
  const promptMarker = `prompt-${randomUUID()}`;
  const toolMarker = `tool-${randomUUID()}`;
  const dirtySources: string[] = [];
  let failWithMarkers = false;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("safe-run-carriers-");
    db = createDb(tempDb.connectionString);
    logDir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "safe-run-carriers-logs-"));
    previousLogPath = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = logDir;
    registerServerAdapter({
      type: ADAPTER_TYPE,
      execute: async (ctx) => {
        if (failWithMarkers) throw new Error(`Adapter failure: ${promptMarker} ${toolMarker}`);
        dirtySources.push(promptMarker, toolMarker);
        await ctx.onMeta({ adapterType: ADAPTER_TYPE, command: "probe", prompt: promptMarker });
        await ctx.onRuntimeProgress?.({ phase: "adapter_startup", message: promptMarker, lastAssistantSnippet: toolMarker });
        await ctx.onEvent({ eventType: "tool.output", message: toolMarker, payload: { output: toolMarker } });
        await ctx.onLog("stdout", `${promptMarker}\n`);
        await ctx.onLog("stderr", `${toolMarker}\n`);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          usage: { inputTokens: 17, outputTokens: 9 },
          usageBasis: "per_run",
          summary: toolMarker,
          resultJson: { summary: promptMarker, stdout: toolMarker, costUsd: 0.025 },
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
  });

  it("drops two unknown markers on write and legacy read while preserving status, usage and exit", async () => {
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
        paperclipWake: { issue: { description: promptMarker }, toolOutput: toolMarker },
        paperclipSecrets: { manifest: [{ bindingId: randomUUID() }] },
      },
      signal: promptMarker,
      nextAction: toolMarker,
      livenessReason: promptMarker,
      resultJson: { summary: promptMarker, stdout: toolMarker, inputTokens: 17 },
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
  }, 60_000);
});
