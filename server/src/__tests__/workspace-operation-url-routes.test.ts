import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, projects, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { createLocalFileWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";
import { workspaceOperationService } from "../services/workspace-operations.js";

const support = await getEmbeddedPostgresTestSupport();
const describeWithPostgres = support.supported ? describe : describe.skip;

describeWithPostgres("workspace operation URL HTTP privacy", { concurrent: false }, () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let logRoot: string;
  const previousLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-operation-url-routes-");
    db = createDb(database.connectionString);
    logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-operation-url-routes-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logRoot;
  }, 120_000);

  afterAll(async () => {
    if (previousLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = previousLogRoot;
    if (logRoot) await fs.rm(logRoot, { recursive: true, force: true });
    await database?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as typeof req.actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("masks old byte pages and new split output for board and agent readers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const operationId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const credential = "synthetic-reader:synthetic-password";
    const url = `postgresql://${credential}@db.example.test/app`;
    const incompleteUrl = `postgresql://${credential}`;
    await db.insert(companies).values({ id: companyId, name: "URL privacy", issuePrefix: "URL" });
    await db.insert(projects).values({ id: projectId, companyId, name: "URL privacy" });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId, companyId, projectId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "URL privacy",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Reader", role: "engineer", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, scopeKind: "company", invocationSource: "assignment",
      status: "succeeded", startedAt: new Date(), finishedAt: new Date(),
    });
    await db.insert(workspaceOperations).values({
      id: operationId, companyId, executionWorkspaceId, heartbeatRunId: runId,
      phase: "provision", status: "succeeded", command: `echo ${url}`,
      metadata: { connection: url }, stdoutExcerpt: `connect ${url}`,
      stderrExcerpt: `connect ${incompleteUrl}`,
      logStore: "local_file", logRef: "pending.ndjson",
    });

    const store = createLocalFileWorkspaceOperationLogStore(logRoot);
    const handle = await store.begin({ companyId, operationId });
    await store.append(handle, { stream: "stdout", chunk: `connect ${url}`, ts: new Date().toISOString() });
    await store.append(handle, { stream: "stderr", chunk: `connect ${incompleteUrl}`, ts: new Date().toISOString() });
    const filePath = path.join(logRoot, handle.logRef);
    const original = await fs.readFile(filePath);
    const expected = Buffer.from(original);
    const credentialOffset = original.indexOf(credential);
    const incompleteCredentialOffset = original.lastIndexOf(credential);
    expect(credentialOffset).toBeGreaterThan(0);
    expect(incompleteCredentialOffset).toBeGreaterThan(credentialOffset);
    expected.fill(0x2a, credentialOffset, credentialOffset + Buffer.byteLength(credential));
    expected.fill(0x2a, incompleteCredentialOffset, incompleteCredentialOffset + Buffer.byteLength(credential));
    await db.update(workspaceOperations).set({ logRef: handle.logRef })
      .where(eq(workspaceOperations.id, operationId));

    const newOperation = await workspaceOperationService(db)
      .createRecorder({ companyId, heartbeatRunId: runId })
      .recordOperation({
        phase: "provision", command: `echo ${url}`, metadata: { connection: url },
        run: async (reportProgress) => {
          await reportProgress({ stdout: "connect postgresql://synthetic-reader:synthetic-" });
          await reportProgress({ stdout: "password@db.example.test/app" });
          return { status: "succeeded" };
        },
      });
    const newFile = await fs.readFile(path.join(logRoot, newOperation.logRef!), "utf8");
    expect(newFile).toContain("postgresql://[REDACTED]@db.example.test/app");
    expect(newFile).not.toContain(credential);

    for (const actor of [
      { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false },
      { type: "agent", agentId, companyId, source: "agent_jwt" },
    ]) {
      const app = createApp(actor);
      const list = await request(app).get(`/api/heartbeat-runs/${runId}/workspace-operations`);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      expect(JSON.stringify(list.body)).not.toContain(credential);
      const historical = list.body.find((operation: { id: string }) => operation.id === operationId);
      expect(historical?.stderrExcerpt).toBe("connect postgresql://[REDACTED]");
      for (const operation of list.body) {
        expect(operation.command).toContain("postgresql://[REDACTED]@db.example.test/app");
        expect(operation.metadata.connection).toContain("postgresql://[REDACTED]@db.example.test/app");
        expect(operation.stdoutExcerpt).toContain("postgresql://[REDACTED]@db.example.test/app");
      }
      const workspaceList = await request(app)
        .get(`/api/execution-workspaces/${executionWorkspaceId}/workspace-operations`);
      expect(workspaceList.status).toBe(200);
      expect(workspaceList.body).toHaveLength(1);
      expect(workspaceList.body[0].stderrExcerpt).toBe("connect postgresql://[REDACTED]");
      expect(JSON.stringify(workspaceList.body)).not.toContain(credential);
      let offset = 0;
      while (offset < original.length) {
        const page = await request(app)
          .get(`/api/workspace-operations/${operationId}/log?offset=${offset}&limitBytes=7`);
        expect(page.status).toBe(200);
        const nextOffset = page.body.nextOffset ?? original.length;
        expect(page.body.content).toBe(expected.subarray(offset, nextOffset).toString("utf8"));
        offset = nextOffset;
      }
      const newLog = await request(app).get(`/api/workspace-operations/${newOperation.id}/log`);
      expect(newLog.status).toBe(200);
      expect(newLog.body.content).not.toContain(credential);
    }
    const foreignApp = createApp({
      type: "agent", agentId: randomUUID(), companyId: randomUUID(), source: "agent_jwt",
    });
    const denied = await request(foreignApp).get(`/api/workspace-operations/${operationId}/log`);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain(credential);
    expect(await fs.readFile(filePath)).toEqual(original);
  });
});
