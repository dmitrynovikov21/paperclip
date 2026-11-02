import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const support = await getEmbeddedPostgresTestSupport();
const describeWithDb = support.supported ? describe : describe.skip;
const adapterType = "synthetic_cookie_output";
const splitEventCases = ["Cookie", "Authorization"].flatMap((header) =>
  Array.from({ length: header.length - 1 }, (_, index) => ({
    header,
    split: index + 1,
    value: `fake-e2e-${header.toLowerCase()}-split-${index + 1}`,
  })),
);
const nestedArrayValue = "fake-e2e-nested-array";
const oldShortEventValue = "fake-e2e-old-short-event";
const crossStreamValue = "fake-e2e-cross-stream";
const oldCrossStreamValue = "fake-e2e-old-cross-stream";
const metadataOrderValue = "fake-e2e-metadata-order";
const oldMetadataOrderValue = "fake-e2e-old-metadata-order";
const cookieValues = [
  "fake-e2e-access", "fake-e2e-refresh", "fake-e2e-csrf",
  "fake-e2e-split", "fake-e2e-array", "fake-e2e-quoted",
  "fake-e2e-pretty", "fake-e2e-event", "fake-e2e-old-event",
  nestedArrayValue, oldShortEventValue, crossStreamValue, oldCrossStreamValue,
  metadataOrderValue, oldMetadataOrderValue,
  ...splitEventCases.map(({ value }) => value),
];
const toolOutput = `Playwright GET timed out\nCookie: __Host-hp_access=${cookieValues[0]}; __Host-hp_refresh=${cookieValues[1]}; __Host-hp_csrf=${cookieValues[2]}\nRequest failed after 30000 ms`;

if (!support.supported) {
  console.warn(`Skipping isolated run-log security integration test: ${support.reason ?? "embedded Postgres unavailable"}`);
}

async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Synthetic adapter run did not finish");
}

describeWithDb("run-log cookie redaction through adapter, database and HTTP", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  let db: ReturnType<typeof createDb>;
  let oldHome: string | undefined;
  let oldApiUrl: string | undefined;
  let oldLogBasePath: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-log-security-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-security-home-"));
    oldHome = process.env.PAPERCLIP_HOME;
    oldApiUrl = process.env.PAPERCLIP_API_URL;
    oldLogBasePath = process.env.RUN_LOG_BASE_PATH;
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    process.env.RUN_LOG_BASE_PATH = path.join(home, "run-logs");
    registerServerAdapter({
      type: adapterType,
      execute: async (ctx) => {
        await ctx.onLog("stderr", toolOutput);
        await ctx.onLog("stderr", "Cook");
        await ctx.onLog("stderr", "ie: ");
        await ctx.onLog("stderr", `session=${cookieValues[3]}\nRequest failed after 30000 ms\n`);
        await ctx.onLog("stderr", String.raw`{\"Set-Cookie\":[\"session=fake-e2e-array\"]}` + "\n");
        await ctx.onLog("stderr", '{"Cookie": [\n');
        await ctx.onLog("stderr", `  "session=${cookieValues[6]}",\n  "other"\n], "safe": "visible"}\n`);
        await ctx.onLog("stderr", '{"Cookie": ["' + "x".repeat(160) + ' Authorization: Bearer synthetic-inner-001');
        await ctx.onLog("stderr", `",\n"session=${nestedArrayValue}"]}\nTimeout after 30000 ms`);
        await ctx.onEvent?.({
          eventType: "tool.output",
          stream: "stderr",
          message: toolOutput + "\n" + String.raw`{\"Cookie\":\"a=\\\"; b=fake-e2e-quoted\"}`,
          payload: { detail: toolOutput + "\n" + String.raw`{\"Set-Cookie\":[\"session=fake-e2e-array\"]}` },
        });
        await ctx.onEvent?.({ eventType: "tool.output", stream: "stderr", message: "Cookie: " });
        await ctx.onEvent?.({ eventType: "tool.output", stream: "stderr", payload: { detail: `session=${cookieValues[7]}\nTimeout after 30000 ms` } });
        for (const { header, split, value } of splitEventCases) {
          await ctx.onEvent?.({ eventType: "tool.output", stream: "stderr", message: header.slice(0, split) });
          const remainder = `${header.slice(split)}: session=${value}\n`;
          await ctx.onEvent?.({
            eventType: "tool.output",
            stream: "stderr",
            message: split % 2 === 0 ? remainder : undefined,
            payload: split % 2 === 1 ? { detail: remainder } : undefined,
          });
          await ctx.onEvent?.({ eventType: "tool.output", stream: "stderr", message: "Timeout after 30000 ms" });
        }
        await ctx.onEvent?.({ eventType: "tool.cross_stream", stream: "stderr", message: "Coo" });
        await ctx.onEvent?.({ eventType: "tool.cross_stream", stream: "stdout", message: "status: worker alive" });
        await ctx.onEvent?.({
          eventType: "tool.cross_stream",
          stream: "stderr",
          payload: { detail: `kie: session=${crossStreamValue}\n` },
        });
        await ctx.onEvent?.({ eventType: "tool.cross_stream", stream: "stderr", message: "safe after cookie" });
        await ctx.onEvent?.({ eventType: "tool.metadata_order", stream: "stderr", message: "Coo" });
        await ctx.onEvent?.({ eventType: "tool.metadata_order", stream: "stdout", message: "status: metadata stream alive" });
        await ctx.onEvent?.({
          eventType: "tool.metadata_order",
          stream: "stderr",
          payload: { toolName: "playwright", detail: `kie: session=${metadataOrderValue}\nRequest failed after 30000 ms` },
        });
        await ctx.onEvent?.({ eventType: "tool.metadata_order", stream: "stderr", message: "safe after metadata cookie" });
        return { exitCode: 0, signal: null, timedOut: false, label: "Synthetic tool output" };
      },
    });
  }, 30_000);

  afterAll(async () => {
    // Run finalization may queue a short detached follow-up after the status
    // becomes terminal. Keep the isolated database alive for that work.
    await new Promise((resolve) => setTimeout(resolve, 250));
    unregisterServerAdapter(adapterType);
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldHome;
    if (oldApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldApiUrl;
    if (oldLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = oldLogBasePath;
    if (home) await fs.rm(home, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("keeps synthetic cookie values out of file, events and API, including an offset into an old log", async () => {
    const companyId = randomUUID();
    const writerId = randomUUID();
    const readerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic Log Security",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([writerId, readerId].map((id) => ({
      id,
      companyId,
      name: id === writerId ? "Log Writer" : "Log Reader",
      role: "engineer",
      status: "idle" as const,
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));

    const liveEvents: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(writerId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const run = await waitForRun(heartbeat, queued!.id);
    unsubscribe();
    expect(run.status).toBe("succeeded");
    expect(run.logRef).toBeTruthy();
    const filePath = path.join(home, "run-logs", run.logRef!);
    const persisted = await fs.readFile(filePath, "utf8");
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(persisted).toContain("Request failed after 30000 ms");
    for (const value of cookieValues) expect(persisted).not.toContain(value);
    expect(persisted).not.toContain("synthetic-inner-001");
    for (const value of cookieValues) expect(JSON.stringify(liveEvents)).not.toContain(value);
    expect(JSON.stringify(liveEvents)).not.toContain("synthetic-inner-001");

    const events = await heartbeat.listEvents(run.id, 0, 200);
    const eventText = JSON.stringify(events);
    expect(eventText).toContain("Request failed after 30000 ms");
    for (const value of cookieValues) expect(eventText).not.toContain(value);
    expect(events.some((event) => event.eventType === "tool.output" && event.message === "Timeout after 30000 ms")).toBe(true);
    expect(events.some((event) => event.eventType === "tool.cross_stream" && event.message === "status: worker alive")).toBe(true);
    expect(events.some((event) => event.eventType === "tool.cross_stream" && event.message === "safe after cookie")).toBe(true);
    expect(events.some((event) => event.eventType === "tool.metadata_order" && event.message === "safe after metadata cookie")).toBe(true);

    const lastSeq = Math.max(...events.map((event) => event.seq));
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 1, eventType: "tool.output", stream: "stderr", message: "Set-Cookie: " },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 2, eventType: "tool.output", stream: "stderr", payload: { detail: `session=${cookieValues[8]}\nTimeout after 30000 ms` } },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 3, eventType: "tool.output", stream: "stderr", message: "Coo" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 4, eventType: "tool.output", stream: "stderr", payload: { detail: `kie: session=${oldShortEventValue}\n` } },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 5, eventType: "tool.old_cross_stream", stream: "stderr", message: "Coo" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 6, eventType: "tool.old_cross_stream", stream: "stdout", message: "status: worker alive (historical)" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 7, eventType: "tool.old_cross_stream", stream: "stderr", payload: { detail: `kie: session=${oldCrossStreamValue}\n` } },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 8, eventType: "tool.old_cross_stream", stream: "stderr", message: "safe after historical cookie" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 9, eventType: "tool.old_metadata_order", stream: "stderr", message: "Coo" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 10, eventType: "tool.old_metadata_order", stream: "stdout", message: "status: metadata stream alive (historical)" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 11, eventType: "tool.old_metadata_order", stream: "stderr", payload: { toolName: "playwright", detail: `kie: session=${oldMetadataOrderValue}\nTimeout after 30000 ms` } },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 12, eventType: "tool.old_metadata_order", stream: "stderr", message: "safe after historical metadata cookie" },
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", agentId: readerId, companyId };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const full = await request(app).get(`/api/heartbeat-runs/${run.id}/log`);
    expect(full.status).toBe(200);
    expect(full.body.content).toContain("Request failed after 30000 ms");
    for (const value of cookieValues) expect(JSON.stringify(full.body)).not.toContain(value);
    const eventResponse = await request(app).get(`/api/heartbeat-runs/${run.id}/events`);
    expect(eventResponse.status).toBe(200);
    for (const value of cookieValues) expect(JSON.stringify(eventResponse.body)).not.toContain(value);
    const crossStreamStart = events.find((event) => event.eventType === "tool.cross_stream" && event.message === "Coo");
    expect(crossStreamStart).toBeDefined();
    const crossStreamPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${crossStreamStart!.seq}`);
    expect(crossStreamPage.status).toBe(200);
    expect(JSON.stringify(crossStreamPage.body)).not.toContain(crossStreamValue);
    expect(JSON.stringify(crossStreamPage.body)).toContain("status: worker alive");
    expect(JSON.stringify(crossStreamPage.body)).toContain("safe after cookie");
    const metadataOrderStart = events.find((event) => event.eventType === "tool.metadata_order" && event.message === "Coo");
    expect(metadataOrderStart).toBeDefined();
    const metadataOrderPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${metadataOrderStart!.seq}`);
    expect(metadataOrderPage.status).toBe(200);
    expect(JSON.stringify(metadataOrderPage.body)).not.toContain(metadataOrderValue);
    expect(JSON.stringify(metadataOrderPage.body)).toContain("status: metadata stream alive");
    expect(JSON.stringify(metadataOrderPage.body)).toContain("safe after metadata cookie");
    const oldEventPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 1}`);
    expect(oldEventPage.status).toBe(200);
    expect(JSON.stringify(oldEventPage.body)).not.toContain(cookieValues[8]);
    const oldShortEventPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 3}`);
    expect(oldShortEventPage.status).toBe(200);
    expect(JSON.stringify(oldShortEventPage.body)).not.toContain(oldShortEventValue);
    const oldCrossStreamPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 5}`);
    expect(oldCrossStreamPage.status).toBe(200);
    expect(JSON.stringify(oldCrossStreamPage.body)).not.toContain(oldCrossStreamValue);
    expect(JSON.stringify(oldCrossStreamPage.body)).toContain("status: worker alive (historical)");
    expect(JSON.stringify(oldCrossStreamPage.body)).toContain("safe after historical cookie");
    const oldMetadataOrderPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 9}`);
    expect(oldMetadataOrderPage.status).toBe(200);
    expect(JSON.stringify(oldMetadataOrderPage.body)).not.toContain(oldMetadataOrderValue);
    expect(JSON.stringify(oldMetadataOrderPage.body)).toContain("status: metadata stream alive (historical)");
    expect(JSON.stringify(oldMetadataOrderPage.body)).toContain("safe after historical metadata cookie");

    // Simulate a historical line written before the new writer guard. Keep the
    // raw fixture on disk so the HTTP reader itself must close the offset gap.
    const oldLine = `${JSON.stringify({ stream: "stderr", chunk: toolOutput })}\n`;
    const oldStart = Buffer.byteLength(persisted);
    await fs.appendFile(filePath, oldLine);
    const offset = oldStart + oldLine.indexOf(cookieValues[1]!) + 4;
    const offsetResponse = await request(app)
      .get(`/api/heartbeat-runs/${run.id}/log?offset=${offset}&limitBytes=8`);
    expect(offsetResponse.status).toBe(200);
    expect(offsetResponse.body.content).toBe("********");
    expect(offsetResponse.body.nextOffset).toBe(offset + 8);

    const historicalSplit = [
      { stream: "stderr", chunk: "Cook" },
      { stream: "stderr", chunk: "ie: " },
      { stream: "stderr", chunk: "session=fake-e2e-split\nRequest failed after 30000 ms" },
    ].map((record) => `${JSON.stringify(record)}\n`).join("");
    const splitStart = Buffer.byteLength(persisted + oldLine);
    await fs.appendFile(filePath, historicalSplit);
    const splitOffset = splitStart + historicalSplit.indexOf(cookieValues[3]!) + 5;
    const splitResponse = await request(app)
      .get(`/api/heartbeat-runs/${run.id}/log?offset=${splitOffset}&limitBytes=8`);
    expect(splitResponse.status).toBe(200);
    expect(splitResponse.body.content).toBe("********");
  }, 30_000);
});
