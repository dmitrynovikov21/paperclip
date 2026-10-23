import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { subscribeCompanyLiveEvents } from "../live-events.js";
import { createHeartbeatRunOutput, type HeartbeatRunOutputInput } from "./run-output.js";

describe("heartbeat run output", () => {
  it("persists and publishes only redacted text when PostgreSQL userinfo spans stdout chunks", async () => {
    const appended: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-1", (event) => {
      if (event.type === "heartbeat.run.log" && event.payload.stream === "stdout" && typeof event.payload.chunk === "string") {
        published.push(event.payload.chunk);
      }
    });
    const db = {
      update: () => ({ set: () => ({ where: async () => [] }) }),
    } as unknown as Db;
    const run = {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
      lastOutputSeq: 0,
      lastOutputAt: null,
      logBytes: 0,
    } as HeartbeatRunOutputInput["run"];
    const runLogStore = {
      begin: async () => ({ store: "local_file", logRef: "synthetic-log" }),
      append: async (_handle: unknown, entry: { stream: "stdout" | "stderr"; chunk: string }) => {
        appended.push({ stream: entry.stream, chunk: entry.chunk });
        return Buffer.byteLength(entry.chunk);
      },
    } as unknown as HeartbeatRunOutputInput["runLogStore"];
    const output = createHeartbeatRunOutput(db, {
      run,
      runId: run.id,
      issueId: null,
      runLogStore,
      identityRedactor: createAgentIdentityRedactor(),
      secretKeys: new Set(),
      appendRunEvent: async () => {},
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });

    try {
      const { onLog } = await output.begin(run);
      await onLog("stdout", "connect postgres://worker:synthetic-");
      await onLog("stderr", "stderr stays separate\n");
      await onLog("stdout", "password@db.example.test/app done\n");
      await onLog("stdout", " postgres://worker:unfinished");
      await output.flushRunLogRedactors();
    } finally {
      unsubscribe();
    }

    const persisted = appended.filter((entry) => entry.stream === "stdout").map((entry) => entry.chunk).join("");
    expect(persisted).toContain("postgres://***REDACTED***@db.example.test/app done");
    expect(persisted).not.toContain("synthetic-password");
    expect(persisted).not.toContain("unfinished");
    expect(output.stdoutExcerpt).toBe(persisted);
    expect(published.join("")).toBe(persisted);
    expect(appended.filter((entry) => entry.stream === "stderr").map((entry) => entry.chunk).join(""))
      .toBe("stderr stays separate\n");
  });

  it.each([",", ";"])("does not persist or publish a second URL's userinfo after %s", async (separator) => {
    const persisted: string[] = [];
    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-1", (event) => {
      if (event.type === "heartbeat.run.log" && typeof event.payload.chunk === "string") {
        published.push(event.payload.chunk);
      }
    });
    const db = {
      update: () => ({ set: () => ({ where: async () => [] }) }),
    } as unknown as Db;
    const run = {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
      lastOutputSeq: 0,
      lastOutputAt: null,
      logBytes: 0,
    } as HeartbeatRunOutputInput["run"];
    const runLogStore = {
      begin: async () => ({ store: "local_file", logRef: "synthetic-log" }),
      append: async (_handle: unknown, entry: { chunk: string }) => {
        persisted.push(entry.chunk);
        return Buffer.byteLength(entry.chunk);
      },
    } as unknown as HeartbeatRunOutputInput["runLogStore"];
    const output = createHeartbeatRunOutput(db, {
      run,
      runId: run.id,
      issueId: null,
      runLogStore,
      identityRedactor: createAgentIdentityRedactor(),
      secretKeys: new Set(),
      appendRunEvent: async () => {},
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });

    try {
      const { onLog } = await output.begin(run);
      for (const chunk of [
        `postgres://first:marker-one@db1/app${separator}post`,
        "gresql://second:marker-two",
        "@db2/app done\n",
      ]) {
        await onLog("stdout", chunk);
        for (const text of [persisted.join(""), published.join(""), output.stdoutExcerpt]) {
          expect(text).not.toContain("marker-one");
          expect(text).not.toContain("marker-two");
        }
      }
      await output.flushRunLogRedactors();
    } finally {
      unsubscribe();
    }

    const expected = `postgres://***REDACTED***@db1/app${separator}postgresql://***REDACTED***@db2/app done\n`;
    expect(persisted.join("")).toBe(expected);
    expect(output.stdoutExcerpt).toBe(expected);
    expect(published.join("")).toBe(expected);
  });
});
