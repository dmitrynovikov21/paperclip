import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginConfig,
  pluginCompanySettings,
  pluginEntities,
  pluginJobs,
  pluginJobRuns,
  pluginLogs,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import { buildHostServices, flushPluginLogBuffer } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin tenant-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin tenant isolation (company_id FK)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-tenant-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginLogs);
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.tenant-isolation-test",
      packageName: "@paperclipai/plugin-tenant-isolation-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.tenant-isolation-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Tenant Isolation Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Tenant ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  it("keeps global job, log, and health diagnostics private to instance admins", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const scopedJobId = randomUUID();
    const instanceJobId = randomUUID();
    await db.insert(pluginJobs).values([
      { id: scopedJobId, pluginId, jobKey: "scoped", schedule: "* * * * *", scope: "company" },
      { id: instanceJobId, pluginId, jobKey: "instance", schedule: "* * * * *" },
    ]);
    await db.insert(pluginJobRuns).values([
      { jobId: scopedJobId, pluginId, companyId: companyA, trigger: "scheduled", status: "failed", error: "A private error", logs: ["A private run log"] },
      { jobId: scopedJobId, pluginId, companyId: companyB, trigger: "scheduled", status: "failed", error: "B private error", logs: ["B private run log"] },
      { jobId: instanceJobId, pluginId, trigger: "scheduled", status: "failed", error: "instance private error", logs: ["instance private run log"] },
    ]);
    await db.insert(pluginLogs).values([
      { pluginId, companyId: companyA, message: "A private plugin log" },
      { pluginId, companyId: companyB, message: "B private plugin log" },
      { pluginId, message: "instance private plugin log" },
    ]);
    await db.update(plugins).set({ lastError: "global private error" }).where(eq(plugins.id, pluginId));

    const app = express();
    app.use((req, _res, next) => {
      const isAdmin = req.header("x-test-admin") === "true";
      req.actor = {
        type: "board",
        source: "session",
        userId: isAdmin ? "admin" : "member-a",
        isInstanceAdmin: isAdmin,
        companyIds: isAdmin ? [] : [companyA],
      } as typeof req.actor;
      next();
    });
    app.use("/api", pluginRoutes(db, {} as never, {
      jobStore: pluginJobStore(db),
      scheduler: {} as never,
    }));
    app.use(errorHandler);

    const base = `/api/plugins/${pluginId}`;
    const diagnosticPaths = [
      `${base}/health`,
      `${base}/logs`,
      `${base}/jobs`,
      `${base}/jobs/${scopedJobId}/runs`,
      `${base}/jobs/${instanceJobId}/runs`,
      `${base}/dashboard`,
    ];
    for (const path of diagnosticPaths) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(403);
      expect(JSON.stringify(response.body), path).not.toContain("private");
    }

    const memberList = await request(app).get("/api/plugins");
    const memberDetail = await request(app).get(base);
    expect(memberList.status).toBe(200);
    expect(memberList.body[0].lastError).toBeNull();
    expect(memberDetail.status).toBe(200);
    expect(memberDetail.body.lastError).toBeNull();

    const admin = (path: string) => request(app).get(path).set("x-test-admin", "true");
    const [runs, instanceRuns, logs, dashboard, health] = await Promise.all([
      admin(`${base}/jobs/${scopedJobId}/runs`),
      admin(`${base}/jobs/${instanceJobId}/runs`),
      admin(`${base}/logs`),
      admin(`${base}/dashboard`),
      admin(`${base}/health`),
    ]);
    expect(runs.status).toBe(200);
    expect(runs.body.map((row: { companyId: string }) => row.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(runs.body.map((row: { error: string }) => row.error).sort()).toEqual(["A private error", "B private error"]);
    expect(instanceRuns.status).toBe(200);
    expect(instanceRuns.body).toMatchObject([{ companyId: null, error: "instance private error" }]);
    expect(logs.status).toBe(200);
    expect(logs.body.map((row: { message: string }) => row.message).sort()).toEqual([
      "A private plugin log", "B private plugin log", "instance private plugin log",
    ].sort());
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.recentJobRuns.map((row: { error: string }) => row.error).sort()).toEqual([
      "A private error", "B private error", "instance private error",
    ]);
    expect(health.status).toBe(200);
    expect(health.body.lastError).toBe("global private error");
  });

  it("allows NULL company_id on plugin_logs (instance-scope rows behave as before)", async () => {
    const pluginId = await seedPlugin();
    await db.insert(pluginLogs).values({
      pluginId,
      // companyId intentionally omitted — NULL means instance-scope.
      level: "info",
      message: "instance-scope log",
    });
    const rows = await db.select().from(pluginLogs).where(eq(pluginLogs.pluginId, pluginId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBeNull();
  });

  it("dispatches configured jobs once per enabled company with an exact host scope", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const disabledCompany = await seedCompany();
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId, pluginId, jobKey: "sync", schedule: "* * * * *", scope: "company",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    await db.insert(pluginConfig).values([companyA, companyB, disabledCompany].map((companyId) => ({
      pluginId, companyId, configJson: { companyId },
    })));
    await db.insert(pluginCompanySettings).values({
      pluginId, companyId: disabledCompany, enabled: false,
    });
    const call = vi.fn(async (_pluginId: string, _method: string, _params: any) => undefined);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: pluginJobStore(db),
      workerManager: { isRunning: () => true, call } as any,
    });

    await scheduler.tick();
    const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    for (const [, method, params] of call.mock.calls) {
      expect(method).toBe("runJob");
      expect(params.companyId).toBe(params.job.companyId);
      expect([companyA, companyB]).toContain(params.companyId);
      expect(runs.some((run) => run.id === params.job.runId && run.companyId === params.companyId)).toBe(true);
    }
    await expect(scheduler.triggerJob(jobId)).rejects.toThrow("Pass companyId");
    await expect(scheduler.triggerJob(jobId, "manual", disabledCompany)).rejects.toThrow("not configured and enabled");
  });

  it("keeps a job instance scoped when its declaration does not opt in", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany();
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId, pluginId, jobKey: "maintenance", schedule: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {} });
    const call = vi.fn(async (_pluginId: string, _method: string, _params: any) => undefined);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: pluginJobStore(db),
      workerManager: { isRunning: () => true, call } as any,
    });

    await scheduler.tick();
    const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.companyId).toBeNull();
    expect(call).toHaveBeenCalledWith(pluginId, "runJob", expect.objectContaining({
      companyId: undefined,
      job: expect.objectContaining({ companyId: undefined }),
    }), expect.any(Number));
    await expect(scheduler.triggerJob(jobId, "manual", companyId)).rejects.toThrow("not configured and enabled");
  });

  it("cascades plugin_logs / plugin_entities / plugin_job_runs / plugin_webhook_deliveries when the owning company is deleted", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Seed a job + run so we can verify plugin_job_runs cascades too.
    const jobAId = randomUUID();
    const jobBId = randomUUID();
    await db.insert(pluginJobs).values([
      { id: jobAId, pluginId, jobKey: "cron-a", schedule: "* * * * *" },
      { id: jobBId, pluginId, jobKey: "cron-b", schedule: "* * * * *" },
    ]);

    await db.insert(pluginLogs).values([
      { pluginId, companyId: companyA, level: "info", message: "A log" },
      { pluginId, companyId: companyB, level: "info", message: "B log" },
      { pluginId, level: "info", message: "instance log" },
    ]);

    await db.insert(pluginEntities).values([
      {
        pluginId,
        companyId: companyA,
        entityType: "issue",
        scopeKind: "company",
        scopeId: companyA,
        externalId: "ext-a",
      },
      {
        pluginId,
        companyId: companyB,
        entityType: "issue",
        scopeKind: "company",
        scopeId: companyB,
        externalId: "ext-b",
      },
    ]);

    await db.insert(pluginJobRuns).values([
      { jobId: jobAId, pluginId, companyId: companyA, trigger: "manual" },
      { jobId: jobBId, pluginId, companyId: companyB, trigger: "manual" },
      { jobId: jobAId, pluginId, trigger: "scheduled" },
    ]);

    await db.insert(pluginWebhookDeliveries).values([
      { pluginId, companyId: companyA, webhookKey: "wh", payload: { who: "A" } },
      { pluginId, companyId: companyB, webhookKey: "wh", payload: { who: "B" } },
      { pluginId, webhookKey: "wh", payload: { who: "instance" } },
    ]);

    // Delete company A — only A's rows should be reaped. B's and NULL-scope rows stay.
    await db.delete(companies).where(eq(companies.id, companyA));

    const logs = await db.select().from(pluginLogs);
    expect(logs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const entities = await db.select().from(pluginEntities);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.companyId).toBe(companyB);

    const runs = await db.select().from(pluginJobRuns);
    expect(runs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const deliveries = await db.select().from(pluginWebhookDeliveries);
    expect(deliveries.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );
  });

  it("plugin_entities unique index is scoped per company — two tenants can share (pluginId, entityType, externalId)", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Company A claims external id "ext-1".
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: companyA,
      entityType: "page",
      scopeKind: "company",
      scopeId: companyA,
      externalId: "ext-1",
    });

    // Company B uses the SAME (pluginId, entityType, externalId) — must succeed
    // under the per-company unique index (would have collided under the old index).
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: companyB,
      entityType: "page",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-1",
    });

    const rows = await db.select().from(pluginEntities);
    expect(rows).toHaveLength(2);

    // Re-inserting the same (companyId, pluginId, entityType, externalId) tuple
    // for company A must violate the unique constraint. Drizzle wraps the
    // underlying pg error as "Failed query: ..." — inspect the cause to confirm
    // it's the unique violation on our index (pg error code 23505).
    const err = await db
      .insert(pluginEntities)
      .values({
        pluginId,
        companyId: companyA,
        entityType: "page",
        scopeKind: "company",
        scopeId: companyA,
        externalId: "ext-1",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    // postgres error code 23505 = unique_violation, the constraint name is
    // not always surfaced on .cause by the driver, but the code is sufficient
    // to prove the unique index rejected the duplicate.
    const cause = (err as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe("23505");
  });

  it("pluginRegistryService.upsertEntity scopes its lookup by companyId — never overwrites another tenant's row", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    const registry = pluginRegistryService(db);

    // Company A claims (issue, ext-shared) with title "A".
    const createdA = await registry.upsertEntity(pluginId, {
      companyId: companyA,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyA,
      externalId: "ext-shared",
      title: "A",
      status: "open",
      data: {},
    });

    // Company B upserts the SAME (entityType, externalId) tuple under its own
    // scope — must create a NEW row for B, NOT overwrite A.
    const createdB = await registry.upsertEntity(pluginId, {
      companyId: companyB,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-shared",
      title: "B",
      status: "open",
      data: {},
    });

    expect(createdA?.id).toBeTruthy();
    expect(createdB?.id).toBeTruthy();
    expect(createdA?.id).not.toBe(createdB?.id);

    // Company B updates its own row — A's row must remain untouched.
    const updatedB = await registry.upsertEntity(pluginId, {
      companyId: companyB,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-shared",
      title: "B-updated",
      status: "closed",
      data: {},
    });
    expect(updatedB?.id).toBe(createdB?.id);
    expect(updatedB?.title).toBe("B-updated");

    const rows = await db.select().from(pluginEntities);
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.companyId === companyA);
    const rowB = rows.find((r) => r.companyId === companyB);
    expect(rowA?.title).toBe("A");
    expect(rowA?.status).toBe("open");
    expect(rowB?.title).toBe("B-updated");
    expect(rowB?.status).toBe("closed");

    // Instance-scope upsert (companyId = NULL) on the same tuple must also
    // create its own row, not collide with A or B.
    const createdInstance = await registry.upsertEntity(pluginId, {
      companyId: null,
      entityType: "issue",
      scopeKind: "instance",
      scopeId: null,
      externalId: "ext-shared",
      title: "instance",
      status: "open",
      data: {},
    });
    expect(createdInstance?.id).toBeTruthy();
    expect(createdInstance?.id).not.toBe(createdA?.id);
    expect(createdInstance?.id).not.toBe(createdB?.id);

    const allRows = await db.select().from(pluginEntities);
    expect(allRows).toHaveLength(3);
  });

  it("pluginRegistryService.getEntityByExternalId scopes by companyId — never returns another tenant's row", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    const registry = pluginRegistryService(db);

    await registry.upsertEntity(pluginId, {
      companyId: companyA,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyA,
      externalId: "ext-shared",
      title: "A",
      status: "open",
      data: {},
    });
    await registry.upsertEntity(pluginId, {
      companyId: companyB,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-shared",
      title: "B",
      status: "open",
      data: {},
    });
    await registry.upsertEntity(pluginId, {
      companyId: null,
      entityType: "issue",
      scopeKind: "instance",
      scopeId: null,
      externalId: "ext-shared",
      title: "instance",
      status: "open",
      data: {},
    });

    const fromA = await registry.getEntityByExternalId(pluginId, "issue", "ext-shared", companyA);
    expect(fromA?.companyId).toBe(companyA);
    expect(fromA?.title).toBe("A");

    const fromB = await registry.getEntityByExternalId(pluginId, "issue", "ext-shared", companyB);
    expect(fromB?.companyId).toBe(companyB);
    expect(fromB?.title).toBe("B");

    const fromInstance = await registry.getEntityByExternalId(pluginId, "issue", "ext-shared", null);
    expect(fromInstance?.companyId).toBeNull();
    expect(fromInstance?.title).toBe("instance");

    // Unknown tenant returns null, not another tenant's row.
    const unknown = await registry.getEntityByExternalId(
      pluginId,
      "issue",
      "ext-shared",
      randomUUID(),
    );
    expect(unknown).toBeNull();
  });

  it("pluginRegistryService.createJobRun + createWebhookDelivery persist companyId so cascade delete reaps them", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    const registry = pluginRegistryService(db);
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "test-job",
      schedule: "* * * * *",
    });

    const runA = await registry.createJobRun(pluginId, jobId, "manual", companyA);
    const runB = await registry.createJobRun(pluginId, jobId, "manual", companyB);
    const runInstance = await registry.createJobRun(pluginId, jobId, "scheduled", null);

    expect(runA?.companyId).toBe(companyA);
    expect(runB?.companyId).toBe(companyB);
    expect(runInstance?.companyId).toBeNull();

    const whA = await registry.createWebhookDelivery(pluginId, "wh", companyA, {
      payload: { who: "A" },
    });
    const whB = await registry.createWebhookDelivery(pluginId, "wh", companyB, {
      payload: { who: "B" },
    });
    const whInstance = await registry.createWebhookDelivery(pluginId, "wh", null, {
      payload: { who: "instance" },
    });

    expect(whA?.companyId).toBe(companyA);
    expect(whB?.companyId).toBe(companyB);
    expect(whInstance?.companyId).toBeNull();

    // Cascade: deleting company A reaps A's rows; B's and instance-scope rows stay.
    await db.delete(companies).where(eq(companies.id, companyA));

    const runs = await db.select().from(pluginJobRuns);
    expect(runs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const deliveries = await db.select().from(pluginWebhookDeliveries);
    expect(
      deliveries.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([companyB, null].sort((a, b) => String(a).localeCompare(String(b))));
  });

  it("buildHostServices.logger.log + flushPluginLogBuffer persist companyId so cascade delete reaps log rows", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Flush any leftovers from prior tests (the buffer is module-scoped).
    await flushPluginLogBuffer();
    await db.delete(pluginLogs);

    const services = buildHostServices(db, pluginId, "tenant-isolation-test", createEventBusStub());
    try {
      await services.logger.log({
        level: "info",
        message: "A log",
        companyId: companyA,
      });
      await services.logger.log({
        level: "warn",
        message: "B log",
        companyId: companyB,
      });
      await services.logger.log({
        level: "info",
        message: "instance log",
        // companyId omitted — explicit instance-scope.
      });
      await services.logger.log({
        level: "debug",
        message: "explicit-null log",
        companyId: null,
      });

      await flushPluginLogBuffer();

      const rows = await db
        .select()
        .from(pluginLogs)
        .where(eq(pluginLogs.pluginId, pluginId));
      const byMessage = new Map(rows.map((r) => [r.message, r]));
      expect(byMessage.get("A log")?.companyId).toBe(companyA);
      expect(byMessage.get("B log")?.companyId).toBe(companyB);
      expect(byMessage.get("instance log")?.companyId).toBeNull();
      expect(byMessage.get("explicit-null log")?.companyId).toBeNull();

      // Cascade: deleting company A reaps A's log row; B's + NULL rows remain.
      await db.delete(companies).where(eq(companies.id, companyA));

      const afterDelete = await db
        .select()
        .from(pluginLogs)
        .where(eq(pluginLogs.pluginId, pluginId));
      const messages = afterDelete.map((r) => r.message).sort();
      expect(messages).toEqual(["B log", "explicit-null log", "instance log"]);
    } finally {
      services.dispose();
      // Ensure no leftover entries leak into other tests.
      await flushPluginLogBuffer();
    }
  });

  it("plugin_entities unique index treats NULL companyId as equal (NULLS NOT DISTINCT) so instance-scope dedup holds", async () => {
    const pluginId = await seedPlugin();

    // First instance-scope entity (companyId = NULL) — succeeds.
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: null,
      entityType: "cron",
      scopeKind: "instance",
      scopeId: null,
      externalId: "global-cron-1",
    });

    // Second instance-scope row with the SAME (pluginId, entityType, externalId)
    // must be rejected. Without `.nullsNotDistinct()`, postgres would treat the
    // two NULL company_ids as distinct and silently allow the duplicate.
    const err = await db
      .insert(pluginEntities)
      .values({
        pluginId,
        companyId: null,
        entityType: "cron",
        scopeKind: "instance",
        scopeId: null,
        externalId: "global-cron-1",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });
});
