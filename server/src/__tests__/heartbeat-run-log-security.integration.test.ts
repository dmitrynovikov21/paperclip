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
let syntheticRunMode: "logs" | "events" = "logs";
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
const metadataBridgeCases = [
  { eventType: "tool.metadata_bridge", value: "fake-e2e-metadata-bridge", metadataInFirstEvent: false, sameStreamMessage: false },
  { eventType: "tool.metadata_first", value: "fake-e2e-metadata-first", metadataInFirstEvent: true, sameStreamMessage: false },
  { eventType: "tool.metadata_message", value: "fake-e2e-metadata-message", metadataInFirstEvent: false, sameStreamMessage: true },
] as const;
const oldMetadataBridgeValue = "fake-e2e-old-metadata-bridge";
const interruptedHeaderCases = ["Cookie", "Set-Cookie", "Authorization"].map((header) => ({
  header,
  eventType: `tool.interrupted_${header.toLowerCase().replace("-", "_")}`,
  value: `fake-e2e-interrupted-${header.toLowerCase()}`,
  oldValue: `fake-e2e-old-interrupted-${header.toLowerCase()}`,
}));
const startedValueCases = ["Cookie", "Set-Cookie", "Authorization"].flatMap((header) =>
  ["worker alive\n", "status=worker-alive\n"].flatMap((independent, middleIndex) =>
    [false, true].map((detailFirst) => ({
      header,
      independent,
      detailFirst,
      eventType: `tool.started_value_${header.toLowerCase().replace("-", "_")}_${middleIndex}_${detailFirst}`,
      value: `fake-e2e-started-${header.toLowerCase()}-${middleIndex}-${detailFirst}`,
      oldValue: `fake-e2e-old-started-${header.toLowerCase()}-${middleIndex}-${detailFirst}`,
    })),
  ),
);
const cookieValues = [
  "fake-e2e-access", "fake-e2e-refresh", "fake-e2e-csrf",
  "fake-e2e-split", "fake-e2e-array", "fake-e2e-quoted",
  "fake-e2e-pretty", "fake-e2e-event", "fake-e2e-old-event",
  nestedArrayValue, oldShortEventValue, crossStreamValue, oldCrossStreamValue,
  metadataOrderValue, oldMetadataOrderValue,
  ...metadataBridgeCases.map(({ value }) => value), oldMetadataBridgeValue,
  ...splitEventCases.map(({ value }) => value),
  ...interruptedHeaderCases.flatMap(({ value, oldValue }) => [value, oldValue]),
  ...startedValueCases.flatMap(({ value, oldValue }) => [value, oldValue]),
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
        if (syntheticRunMode === "logs") {
          await ctx.onLog("stderr", toolOutput);
          await ctx.onLog("stderr", "Cook");
          await ctx.onLog("stderr", "ie: ");
          await ctx.onLog("stderr", `session=${cookieValues[3]}\nRequest failed after 30000 ms\n`);
          await ctx.onLog("stderr", String.raw`{\"Set-Cookie\":[\"session=fake-e2e-array\"]}` + "\n");
          await ctx.onLog("stderr", '{"Cookie": [\n');
          await ctx.onLog("stderr", `  "session=${cookieValues[6]}",\n  "other"\n], "safe": "visible"}\n`);
          await ctx.onLog("stderr", '{"Cookie": ["' + "x".repeat(160) + ' Authorization: Bearer synthetic-inner-001');
          await ctx.onLog("stderr", `",\n"session=${nestedArrayValue}"]}\nTimeout after 30000 ms`);
          return { exitCode: 0, signal: null, timedOut: false, label: "Synthetic log output" };
        }
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
        for (const { eventType, value, metadataInFirstEvent, sameStreamMessage } of metadataBridgeCases) {
          await ctx.onEvent?.({
            eventType,
            stream: "stderr",
            message: "Coo",
            ...(metadataInFirstEvent ? { payload: { toolName: "playwright" } } : {}),
          });
          await ctx.onEvent?.({ eventType, stream: "stdout", message: "status: other stream alive" });
          if (!metadataInFirstEvent) {
            await ctx.onEvent?.({
              eventType,
              stream: "stderr",
              ...(sameStreamMessage ? { message: "status: metadata event alive" } : {}),
              payload: { toolName: "playwright" },
            });
          }
          await ctx.onEvent?.({
            eventType,
            stream: "stderr",
            payload: { detail: `kie: session=${value}\nRequest failed after 30000 ms` },
          });
          await ctx.onEvent?.({ eventType, stream: "stderr", message: "safe after metadata bridge" });
        }
        for (const { header, eventType, value } of interruptedHeaderCases) {
          await ctx.onEvent?.({ eventType, stream: "stderr", message: `${header}: ` });
          await ctx.onEvent?.({ eventType, stream: "stderr", payload: { toolName: "playwright" } });
          await ctx.onEvent?.({ eventType, stream: "stderr", message: "status: worker alive\n" });
          await ctx.onEvent?.({
            eventType,
            stream: "stderr",
            payload: { detail: `${header === "Authorization" ? "Bearer " : "session="}${value}\nRequest failed after 30000 ms` },
          });
          await ctx.onEvent?.({ eventType, stream: "stderr", message: "safe after interrupted header" });
        }
        for (const { header, eventType, value, independent, detailFirst } of startedValueCases) {
          const prefix = header === "Authorization" ? "Bearer " : "session=";
          await ctx.onEvent?.({ eventType, stream: "stderr", message: `${header}: ${prefix}` });
          await ctx.onEvent?.({ eventType, stream: "stderr", payload: { toolName: "playwright" } });
          await ctx.onEvent?.({ eventType, stream: "stderr", message: independent });
          const detail = `${value}\nRequest failed after 30000 ms`;
          await ctx.onEvent?.({
            eventType,
            stream: "stderr",
            payload: detailFirst ? { detail, toolName: "playwright" } : { toolName: "playwright", detail },
          });
          await ctx.onEvent?.({ eventType, stream: "stderr", message: "safe diagnostic after value" });
        }
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
    syntheticRunMode = "logs";
    const logQueued = await heartbeat.invoke(writerId, "on_demand", {}, "manual");
    expect(logQueued).not.toBeNull();
    const logRun = await waitForRun(heartbeat, logQueued!.id);
    expect(logRun.status).toBe("succeeded");
    syntheticRunMode = "events";
    const queued = await heartbeat.invoke(writerId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const run = await waitForRun(heartbeat, queued!.id);
    unsubscribe();
    expect(run.status).toBe("succeeded");
    expect(logRun.logRef).toBeTruthy();
    const filePath = path.join(home, "run-logs", logRun.logRef!);
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
    for (const { eventType } of metadataBridgeCases) {
      expect(events.some((event) => event.eventType === eventType && event.message === "safe after metadata bridge")).toBe(true);
    }
    for (const { eventType } of interruptedHeaderCases) {
      expect(events.some((event) => event.eventType === eventType && event.message === "status: worker alive\n")).toBe(true);
      expect(events.some((event) => event.eventType === eventType && event.message === "safe after interrupted header")).toBe(true);
    }
    for (const { eventType } of startedValueCases) {
      expect(events.some((event) => event.eventType === eventType && event.message === "safe diagnostic after value")).toBe(true);
    }

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
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 13, eventType: "tool.old_metadata_bridge", stream: "stderr", message: "Coo" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 14, eventType: "tool.old_metadata_bridge", stream: "stdout", message: "status: other historical stream alive" },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 15, eventType: "tool.old_metadata_bridge", stream: "stderr", payload: { toolName: "playwright" } },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 16, eventType: "tool.old_metadata_bridge", stream: "stderr", payload: { detail: `kie: session=${oldMetadataBridgeValue}\nRequest failed after 30000 ms` } },
      { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 17, eventType: "tool.old_metadata_bridge", stream: "stderr", message: "safe after historical metadata bridge" },
      ...interruptedHeaderCases.flatMap(({ header, eventType, oldValue }, index) => {
        const seq = lastSeq + 18 + index * 5;
        return [
          { companyId, runId: run.id, agentId: writerId, seq, eventType, stream: "stderr", message: `${header}: ` },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 1, eventType, stream: "stderr", payload: { toolName: "playwright" } },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 2, eventType, stream: "stderr", message: "status: worker alive\n" },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 3, eventType, stream: "stderr", payload: { detail: `${header === "Authorization" ? "Bearer " : "session="}${oldValue}\nRequest failed after 30000 ms` } },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 4, eventType, stream: "stderr", message: "safe after interrupted header" },
        ];
      }),
      ...startedValueCases.flatMap(({ header, eventType, independent, detailFirst, oldValue }, index) => {
        const seq = lastSeq + 18 + interruptedHeaderCases.length * 5 + index * 5;
        const prefix = header === "Authorization" ? "Bearer " : "session=";
        const detail = `${oldValue}\nRequest failed after 30000 ms`;
        return [
          { companyId, runId: run.id, agentId: writerId, seq, eventType, stream: "stderr", message: `${header}: ${prefix}` },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 1, eventType, stream: "stderr", payload: { toolName: "playwright" } },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 2, eventType, stream: "stderr", message: independent },
          {
            companyId, runId: run.id, agentId: writerId, seq: seq + 3, eventType, stream: "stderr",
            payload: detailFirst ? { detail, toolName: "playwright" } : { toolName: "playwright", detail },
          },
          { companyId, runId: run.id, agentId: writerId, seq: seq + 4, eventType, stream: "stderr", message: "safe diagnostic after value" },
        ];
      }),
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", agentId: readerId, companyId };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const full = await request(app).get(`/api/heartbeat-runs/${logRun.id}/log`);
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
    for (const { eventType, value, sameStreamMessage } of metadataBridgeCases) {
      const start = events.find((event) => event.eventType === eventType && event.message === "Coo");
      expect(start).toBeDefined();
      const page = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${start!.seq}`);
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.body)).not.toContain(value);
      expect(JSON.stringify(page.body)).toContain("safe after metadata bridge");
      if (sameStreamMessage) expect(JSON.stringify(page.body)).toContain("status: metadata event alive");
    }
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
    const oldMetadataBridgePage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 13}`);
    expect(oldMetadataBridgePage.status).toBe(200);
    expect(JSON.stringify(oldMetadataBridgePage.body)).not.toContain(oldMetadataBridgeValue);
    expect(JSON.stringify(oldMetadataBridgePage.body)).toContain("safe after historical metadata bridge");
    for (const [{ oldValue }, index] of interruptedHeaderCases.entries()) {
      const startSeq = lastSeq + 18 + index * 5;
      const page = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${startSeq}`);
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.body)).not.toContain(oldValue);
      expect(JSON.stringify(page.body)).toContain("status: worker alive\\n");
      expect(JSON.stringify(page.body)).toContain("safe after interrupted header");
    }
    for (const [{ oldValue }, index] of startedValueCases.entries()) {
      const startSeq = lastSeq + 18 + interruptedHeaderCases.length * 5 + index * 5;
      const page = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${startSeq}`);
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.body)).not.toContain(oldValue);
      expect(JSON.stringify(page.body)).toContain("safe diagnostic after value");
    }

    // Simulate a historical line written before the new writer guard. Keep the
    // raw fixture on disk so the HTTP reader itself must close the offset gap.
    const oldLine = `${JSON.stringify({ stream: "stderr", chunk: toolOutput })}\n`;
    const oldStart = Buffer.byteLength(persisted);
    await fs.appendFile(filePath, oldLine);
    const offset = oldStart + oldLine.indexOf(cookieValues[1]!) + 4;
    const offsetResponse = await request(app)
      .get(`/api/heartbeat-runs/${logRun.id}/log?offset=${offset}&limitBytes=8`);
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
      .get(`/api/heartbeat-runs/${logRun.id}/log?offset=${splitOffset}&limitBytes=8`);
    expect(splitResponse.status).toBe(200);
    expect(splitResponse.body.content).toBe("********");
  }, 30_000);

  it("masks header continuations across log and event callbacks with unrelated output", async () => {
    const crossAdapterType = "synthetic_cross_callback_headers";
    const scenarios = (["Cookie", "Set-Cookie", "Authorization"] as const).flatMap((header) =>
      (["stderr", "stdout"] as const).flatMap((stream) =>
        (["name", "json"] as const).map((variant) => ({ header, stream, variant })),
      ),
    );
    let currentScenario: (typeof scenarios)[number] | null = null;
    registerServerAdapter({
      type: crossAdapterType,
      execute: async (ctx) => {
        if (!currentScenario) throw new Error("Synthetic scenario is missing");
        const { header, stream, variant } = currentScenario;
        const prefix = header === "Authorization" ? "OAuth " : "session=";
        const value = `synthetic-${variant}-${header.toLowerCase()}-${stream}`;
        if (variant === "name") {
          const split = header === "Cookie" ? 3 : header === "Set-Cookie" ? 6 : 4;
          await ctx.onLog(stream, header.slice(0, split));
          await ctx.onLog(stream, "status: worker alive\n");
          await ctx.onEvent?.({ eventType: "tool.cross_callback", stream, payload: { toolName: "playwright" } });
          await ctx.onEvent?.({
            eventType: "tool.cross_callback", stream,
            payload: { detail: `${header.slice(split)}: ${prefix}${value}\nRequest failed after 30000 ms` },
          });
        } else {
          await ctx.onLog(stream, `{"${header}":["${prefix}`);
          await ctx.onLog(stream, '"]}\n');
          await ctx.onEvent?.({ eventType: "tool.cross_callback", stream, payload: { toolName: "playwright" } });
          await ctx.onEvent?.({
            eventType: "tool.cross_callback", stream,
            payload: { detail: `${value}  "]}\nRequest failed after 30000 ms` },
          });
        }
        const otherStream = stream === "stderr" ? "stdout" : "stderr";
        await ctx.onEvent?.({ eventType: "tool.other_stream", stream: otherStream, message: "independent stream is live" });
        return { exitCode: 0, signal: null, timedOut: false, label: "Synthetic cross-callback output" };
      },
    });
    try {
      const companyId = randomUUID();
      const writerId = randomUUID();
      const readerId = randomUUID();
      await db.insert(companies).values({
        id: companyId, name: "Synthetic Cross Callback Security",
        issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values([writerId, readerId].map((id) => ({
        id, companyId, name: id === writerId ? "Callback Writer" : "Callback Reader",
        role: "engineer", status: "idle" as const, adapterType: crossAdapterType,
        adapterConfig: {}, runtimeConfig: {}, permissions: {},
      })));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = { type: "agent", agentId: readerId, companyId };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      const heartbeat = heartbeatService(db);
      for (const scenario of scenarios) {
        currentScenario = scenario;
        const { header, stream, variant } = scenario;
        const value = `synthetic-${variant}-${header.toLowerCase()}-${stream}`;
        const liveEvents: unknown[] = [];
        const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
        try {
          const queued = await heartbeat.invoke(writerId, "on_demand", {}, "manual");
          expect(queued).not.toBeNull();
          const run = await waitForRun(heartbeat, queued!.id);
          expect(run.status).toBe("succeeded");
          const persisted = await fs.readFile(path.join(home, "run-logs", run.logRef!), "utf8");
          const events = await heartbeat.listEvents(run.id, 0, 100);
          const detailEvent = events.find((event) => event.eventType === "tool.cross_callback"
            && typeof event.payload?.detail === "string");
          expect(detailEvent, `${header} ${stream} ${variant} event`).toBeDefined();
          expect(detailEvent?.payload?.detail).toContain("Request failed after 30000 ms");
          expect(events.some((event) => event.eventType === "tool.other_stream"
            && event.message === "independent stream is live")).toBe(true);
          for (const content of [persisted, JSON.stringify(run), JSON.stringify(events), JSON.stringify(liveEvents)]) {
            expect(content, `${header} ${stream} ${variant} persisted/live`).not.toContain(value);
          }
          const eventPage = await request(app)
            .get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${detailEvent!.seq - 1}`);
          const logPage = await request(app).get(`/api/heartbeat-runs/${run.id}/log`);
          expect(eventPage.status).toBe(200);
          expect(logPage.status).toBe(200);
          expect(JSON.stringify(eventPage.body), `${header} ${stream} ${variant} HTTP events`).not.toContain(value);
          expect(JSON.stringify(logPage.body), `${header} ${stream} ${variant} HTTP log`).not.toContain(value);
          expect(JSON.stringify(eventPage.body)).toContain("Request failed after 30000 ms");
        } finally {
          unsubscribe();
        }
      }
    } finally {
      unregisterServerAdapter(crossAdapterType);
    }
  }, 60_000);

  it("masks JSON credential tails after unrelated adapter output in live, stored and historical reads", async () => {
    const jsonAdapterType = "synthetic_json_cookie_output";
    const cases = [
      { header: "Cookie", stream: "stderr", jsonArray: false, detailFirst: false },
      { header: "Set-Cookie", stream: "stdout", jsonArray: true, detailFirst: true },
      { header: "Authorization", stream: "system", jsonArray: false, detailFirst: true },
    ] as const;
    const valueFor = (header: string) => `synthetic-json-event-${header.toLowerCase()}`;
    const crossEventToLogFor = (header: string) => `synthetic-json-event-log-${header.toLowerCase()}`;
    const crossLogToEventFor = (header: string) => `synthetic-json-log-event-${header.toLowerCase()}`;
    const prefixFor = (header: string) => header === "Authorization" ? "Bearer " : "session=";
    const openingFor = (header: string, jsonArray: boolean) =>
      jsonArray ? `{"${header}":["${prefixFor(header)}` : `{"${header}":"${prefixFor(header)}`;
    const middleFor = (jsonArray: boolean) => jsonArray ? 'worker "] alive\n' : 'worker "alive"\n';
    const closingFor = (jsonArray: boolean) => jsonArray ? '"]}' : '"}';
    registerServerAdapter({
      type: jsonAdapterType,
      execute: async (ctx) => {
        for (const { header, stream, jsonArray, detailFirst } of cases) {
          const eventType = `tool.json_${header.toLowerCase().replace("-", "_")}`;
          await ctx.onEvent?.({ eventType, stream, message: openingFor(header, jsonArray) });
          await ctx.onEvent?.({ eventType, stream, payload: { toolName: "playwright" } });
          await ctx.onEvent?.({ eventType, stream, message: middleFor(jsonArray) });
          const detail = `${valueFor(header)}${closingFor(jsonArray)}\nRequest failed after 30000 ms`;
          await ctx.onEvent?.({
            eventType, stream,
            payload: detailFirst ? { detail, toolName: "playwright" } : { toolName: "playwright", detail },
          });
          if (stream !== "system") {
            await ctx.onLog(stream, openingFor(header, jsonArray));
            await ctx.onLog(stream, middleFor(jsonArray));
            await ctx.onLog(stream, `${valueFor(header)}${closingFor(jsonArray)}\nRequest failed after 30000 ms`);
            await ctx.onEvent?.({ eventType: `${eventType}_cross_event_log`, stream, message: openingFor(header, jsonArray) });
            await ctx.onEvent?.({ eventType: `${eventType}_cross_event_log`, stream, payload: { toolName: "playwright" } });
            await ctx.onEvent?.({ eventType: `${eventType}_cross_event_log`, stream, message: middleFor(jsonArray) });
            await ctx.onLog(stream, `${crossEventToLogFor(header)}${closingFor(jsonArray)}\nRequest failed after 30000 ms`);
            await ctx.onLog(stream, openingFor(header, jsonArray));
            await ctx.onEvent?.({ eventType: `${eventType}_cross_log_event`, stream, message: middleFor(jsonArray) });
            await ctx.onEvent?.({
              eventType: `${eventType}_cross_log_event`, stream,
              payload: { detail: `${crossLogToEventFor(header)}${closingFor(jsonArray)}\nRequest failed after 30000 ms` },
            });
          }
        }
        return { exitCode: 0, signal: null, timedOut: false, label: "Synthetic JSON tool output" };
      },
    });
    try {
      const companyId = randomUUID();
      const writerId = randomUUID();
      const readerId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Synthetic JSON Log Security",
        issuePrefix: `J${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values([writerId, readerId].map((id) => ({
        id, companyId, name: id === writerId ? "JSON Log Writer" : "JSON Log Reader",
        role: "engineer", status: "idle" as const, adapterType: jsonAdapterType,
        adapterConfig: {}, runtimeConfig: {}, permissions: {},
      })));
      const liveEvents: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.invoke(writerId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      const run = await waitForRun(heartbeat, queued!.id);
      unsubscribe();
      expect(run.status).toBe("succeeded");
      const filePath = path.join(home, "run-logs", run.logRef!);
      const persisted = await fs.readFile(filePath, "utf8");
      const events = await heartbeat.listEvents(run.id, 0, 200);
      for (const { header } of cases) {
        const value = valueFor(header);
        expect(persisted).not.toContain(value);
        expect(JSON.stringify(events)).not.toContain(value);
        expect(JSON.stringify(liveEvents)).not.toContain(value);
        const eventType = `tool.json_${header.toLowerCase().replace("-", "_")}`;
        expect(events.some((event) => event.eventType === eventType &&
          typeof event.payload?.detail === "string" && event.payload.detail.includes("Request failed after 30000 ms"))).toBe(true);
        for (const crossValue of [crossEventToLogFor(header), crossLogToEventFor(header)]) {
          expect(persisted).not.toContain(crossValue);
          expect(JSON.stringify(events)).not.toContain(crossValue);
          expect(JSON.stringify(liveEvents)).not.toContain(crossValue);
        }
      }

      const lastSeq = Math.max(...events.map((event) => event.seq));
      const legacyValue = "synthetic-json-legacy-tail";
      await db.insert(heartbeatRunEvents).values([
        { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 1, eventType: "tool.json_legacy", stream: "stderr", message: '{"Cookie":"session=' },
        { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 2, eventType: "tool.json_legacy", stream: "stderr", payload: { toolName: "playwright" } },
        { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 3, eventType: "tool.json_legacy", stream: "stderr", message: 'worker "alive"\n' },
        { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 4, eventType: "tool.json_legacy", stream: "stderr", payload: { detail: `${legacyValue}"}\nRequest failed after 30000 ms` } },
      ]);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = { type: "agent", agentId: readerId, companyId };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      const writtenEventsPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events`);
      const writtenLogPage = await request(app).get(`/api/heartbeat-runs/${run.id}/log`);
      expect(writtenEventsPage.status).toBe(200);
      expect(writtenLogPage.status).toBe(200);
      for (const { header } of cases) {
        expect(JSON.stringify(writtenEventsPage.body)).not.toContain(valueFor(header));
        expect(JSON.stringify(writtenLogPage.body)).not.toContain(valueFor(header));
        expect(JSON.stringify(writtenEventsPage.body)).not.toContain(crossLogToEventFor(header));
        expect(JSON.stringify(writtenLogPage.body)).not.toContain(crossEventToLogFor(header));
      }
      const eventPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 1}`);
      expect(eventPage.status).toBe(200);
      expect(JSON.stringify(eventPage.body)).not.toContain(legacyValue);
      expect(JSON.stringify(eventPage.body)).toContain("Request failed after 30000 ms");

      const oldRecords = [
        { stream: "stderr", chunk: '{"Cookie":"session=' },
        { stream: "stderr", chunk: 'worker "alive"\n' },
        { stream: "stderr", chunk: `${legacyValue}"}\nRequest failed after 30000 ms` },
      ].map((record) => `${JSON.stringify(record)}\n`).join("");
      const oldStart = Buffer.byteLength(persisted);
      await fs.appendFile(filePath, oldRecords);
      const offset = oldStart + oldRecords.indexOf(legacyValue) + 4;
      const logPage = await request(app).get(`/api/heartbeat-runs/${run.id}/log?offset=${offset}&limitBytes=8`);
      expect(logPage.status).toBe(200);
      expect(logPage.body.content).toBe("********");
    } finally {
      unregisterServerAdapter(jsonAdapterType);
    }
  }, 30_000);

  it("masks unknown Authorization schemes through adapter events, log writer and HTTP readers", async () => {
    for (const scheme of ["ApiKey", "OAuth"] as const) {
      const authAdapterType = `synthetic_auth_scheme_${scheme.toLowerCase()}`;
      const value = `synthetic-${scheme}-integration-credential`;
      const eventToLogValue = `synthetic-${scheme}-event-to-log`;
      const logToEventValue = `synthetic-${scheme}-log-to-event`;
      const spacedValue = `synthetic-${scheme}-spaced-value`;
      registerServerAdapter({
        type: authAdapterType,
        execute: async (ctx) => {
          await ctx.onEvent?.({ eventType: "tool.auth", stream: "stderr", message: "Authorization: " });
          await ctx.onEvent?.({ eventType: "tool.auth", stream: "stderr", payload: { toolName: "playwright" } });
          await ctx.onEvent?.({ eventType: "tool.auth", stream: "stderr", message: "status: worker alive\n" });
          await ctx.onEvent?.({
            eventType: "tool.auth", stream: "stderr",
            payload: { detail: `${scheme} ${value}\nRequest failed after 30000 ms` },
          });
          await ctx.onLog("stdout", "Authorization: ");
          await ctx.onLog("stdout", "status: worker alive\n");
          await ctx.onLog("stdout", `${scheme} ${value}\nRequest failed after 30000 ms`);
          await ctx.onEvent?.({ eventType: "tool.auth_event_to_log", stream: "stderr", message: "Authorization: " });
          await ctx.onEvent?.({ eventType: "tool.auth_event_to_log", stream: "stderr", payload: { toolName: "playwright" } });
          await ctx.onEvent?.({ eventType: "tool.auth_event_to_log", stream: "stderr", message: "status: worker alive\n" });
          await ctx.onLog("stderr", `${scheme} ${eventToLogValue}\nRequest failed after 30000 ms`);
          await ctx.onLog("stdout", "Authorization: ");
          await ctx.onLog("stdout", "status: worker alive\n");
          await ctx.onEvent?.({
            eventType: "tool.auth_log_to_event", stream: "stdout",
            payload: { detail: `${scheme} ${logToEventValue}\nRequest failed after 30000 ms` },
          });
          await ctx.onEvent?.({ eventType: "tool.auth_spaced", stream: "stderr", message: `Authorization: ${scheme} ` });
          await ctx.onEvent?.({ eventType: "tool.auth_spaced", stream: "stderr", payload: { toolName: "playwright" } });
          await ctx.onEvent?.({ eventType: "tool.auth_spaced", stream: "stderr", message: "status: worker alive\n" });
          await ctx.onLog("stderr", `${spacedValue}  \nRequest failed after 30000 ms`);
          return { exitCode: 0, signal: null, timedOut: false, label: "Synthetic auth output" };
        },
      });
      try {
        const companyId = randomUUID();
        const writerId = randomUUID();
        const readerId = randomUUID();
        await db.insert(companies).values({
          id: companyId,
          name: `Synthetic ${scheme} Log Security`,
          issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
          requireBoardApprovalForNewAgents: false,
          defaultResponsibleUserId: "responsible-user",
        });
        await db.insert(agents).values([writerId, readerId].map((id) => ({
          id, companyId, name: id === writerId ? "Auth Log Writer" : "Auth Log Reader",
          role: "engineer", status: "idle" as const, adapterType: authAdapterType,
          adapterConfig: {}, runtimeConfig: {}, permissions: {},
        })));
        const liveEvents: unknown[] = [];
        const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
        const heartbeat = heartbeatService(db);
        const queued = await heartbeat.invoke(writerId, "on_demand", {}, "manual");
        expect(queued).not.toBeNull();
        const run = await waitForRun(heartbeat, queued!.id);
        unsubscribe();
        expect(run.status).toBe("succeeded");
        const filePath = path.join(home, "run-logs", run.logRef!);
        const persisted = await fs.readFile(filePath, "utf8");
        const events = await heartbeat.listEvents(run.id, 0, 100);
        for (const content of [persisted, JSON.stringify(events), JSON.stringify(liveEvents)]) {
          for (const secret of [value, eventToLogValue, logToEventValue, spacedValue]) {
            expect(content, `${scheme} writer/live`).not.toContain(secret);
          }
          expect(content).toContain("Request failed after 30000 ms");
        }
        for (const secret of [value, eventToLogValue, logToEventValue, spacedValue]) {
          expect(JSON.stringify(run), `${scheme} run excerpts`).not.toContain(secret);
        }

        const lastSeq = Math.max(...events.map((event) => event.seq));
        await db.insert(heartbeatRunEvents).values([
          { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 1, eventType: "tool.old_auth", stream: "system", message: "Authorization: " },
          { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 2, eventType: "tool.old_auth", stream: "system", payload: { detail: `${scheme} ${value}\nRequest failed after 30000 ms` } },
          { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 3, eventType: "tool.old_auth_spaced", stream: "system", message: `Authorization: ${scheme} ` },
          { companyId, runId: run.id, agentId: writerId, seq: lastSeq + 4, eventType: "tool.old_auth_spaced", stream: "system", payload: { detail: `${spacedValue}  \nRequest failed after 30000 ms` } },
        ]);
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          (req as any).actor = { type: "agent", agentId: readerId, companyId };
          next();
        });
        app.use("/api", agentRoutes(db));
        app.use(errorHandler);
        const eventPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events`);
        expect(eventPage.status).toBe(200);
        expect(JSON.stringify(eventPage.body)).not.toContain(value);
        expect(JSON.stringify(eventPage.body)).not.toContain(logToEventValue);
        expect(JSON.stringify(eventPage.body)).not.toContain(spacedValue);
        expect(JSON.stringify(eventPage.body)).toContain("Request failed after 30000 ms");
        const oldEventPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 1}`);
        expect(oldEventPage.status).toBe(200);
        expect(JSON.stringify(oldEventPage.body)).not.toContain(value);
        const oldSpacedEventPage = await request(app).get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${lastSeq + 3}`);
        expect(oldSpacedEventPage.status).toBe(200);
        expect(JSON.stringify(oldSpacedEventPage.body)).not.toContain(spacedValue);

        const raw = ["Authorization: ", `${scheme} ${value}\nRequest failed after 30000 ms`]
          .map((chunk) => `${JSON.stringify({ stream: "stderr", chunk })}\n`).join("");
        const offset = Buffer.byteLength(persisted) + Buffer.byteLength(raw.slice(0, raw.indexOf(value) + 4));
        await fs.appendFile(filePath, raw);
        const logPage = await request(app).get(`/api/heartbeat-runs/${run.id}/log?offset=${offset}&limitBytes=8`);
        expect(logPage.status).toBe(200);
        expect(logPage.body.content).toBe("********");
        const spacedRaw = [`Authorization: ${scheme} `, `${spacedValue}  \nRequest failed after 30000 ms`]
          .map((chunk) => `${JSON.stringify({ stream: "stderr", chunk })}\n`).join("");
        const spacedOffset = Buffer.byteLength(persisted + raw) + Buffer.byteLength(spacedRaw.slice(0, spacedRaw.indexOf(spacedValue) + 4));
        await fs.appendFile(filePath, spacedRaw);
        const spacedLogPage = await request(app).get(`/api/heartbeat-runs/${run.id}/log?offset=${spacedOffset}&limitBytes=8`);
        expect(spacedLogPage.status).toBe(200);
        expect(spacedLogPage.body.content).toBe("********");
      } finally {
        unregisterServerAdapter(authAdapterType);
      }
    }
  }, 30_000);
});
