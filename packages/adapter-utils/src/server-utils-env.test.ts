import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";
import { projectAcpxInheritedHostEnvironment } from "./acpx-engine/execute.js";

afterEach(() => vi.unstubAllEnvs());

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("does not pass source signing keys to local or ACPX agent processes", () => {
    const inherited = {
      PATH: "/usr/bin",
      PAPERCLIP_API_KEY: "synthetic-host-token",
      BETTER_AUTH_SECRET: "synthetic-human-auth",
      PAPERCLIP_AGENT_JWT_SECRET: "synthetic-jwt",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "synthetic-actions",
      PAPERCLIP_DECISION_SIGNING_SECRET: "synthetic-decisions",
    };
    expect(sanitizeInheritedPaperclipEnv(inherited)).toEqual({ PATH: "/usr/bin" });
    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", true)).toEqual({ PATH: "/usr/bin" });
    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", false)).toEqual({});
  });

  it("does not expose host signing secrets in a real local agent process", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-human-auth");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-jwt");
    vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "synthetic-actions");
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "synthetic-decisions");
    vi.stubEnv("PAPERCLIP_API_KEY", "synthetic-host-token");

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify({
        hostAuth: "BETTER_AUTH_SECRET" in process.env,
        agentJwtSecret: "PAPERCLIP_AGENT_JWT_SECRET" in process.env,
        toolSigningSecret: "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET" in process.env,
        decisionSigningSecret: "PAPERCLIP_DECISION_SIGNING_SECRET" in process.env,
        runToken: process.env.PAPERCLIP_API_KEY === "synthetic-run-token",
        runId: process.env.PAPERCLIP_RUN_ID === "synthetic-run-id"
      }))`],
      {
        cwd: process.cwd(),
        env: {
          PAPERCLIP_API_KEY: "synthetic-run-token",
          PAPERCLIP_RUN_ID: "synthetic-run-id",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hostAuth: false,
      agentJwtSecret: false,
      toolSigningSecret: false,
      decisionSigningSecret: false,
      runToken: true,
      runId: true,
    });
  });
});
