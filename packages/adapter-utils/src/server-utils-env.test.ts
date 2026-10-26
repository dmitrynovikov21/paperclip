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
      PAPERCLIP_AUTH_SECRET: "synthetic-auth",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "synthetic-actions",
      PAPERCLIP_DECISION_SIGNING_SECRET: "synthetic-decisions",
      PAPERCLIP_SECRETS_MASTER_KEY: "synthetic-master-key",
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/synthetic/master-key",
      PAPERCLIP_WORKSPACE_HANDOFF_SECRET: "synthetic-handoff",
    };
    expect(sanitizeInheritedPaperclipEnv(inherited)).toEqual({ PATH: "/usr/bin" });
    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", true)).toEqual({ PATH: "/usr/bin" });
    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", false)).toEqual({});
  });

  it("does not expose host signing secrets in a real local agent process", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-human-auth");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-jwt");
    vi.stubEnv("PAPERCLIP_AUTH_SECRET", "synthetic-auth");
    vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "synthetic-actions");
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "synthetic-decisions");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "synthetic-master-key");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "/synthetic/master-key");
    vi.stubEnv("PAPERCLIP_WORKSPACE_HANDOFF_SECRET", "synthetic-handoff");
    vi.stubEnv("PAPERCLIP_API_KEY", "synthetic-host-token");

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify({
        hostAuth: "BETTER_AUTH_SECRET" in process.env,
        agentJwtSecret: "PAPERCLIP_AGENT_JWT_SECRET" in process.env,
        authSecret: "PAPERCLIP_AUTH_SECRET" in process.env,
        toolSigningSecret: "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET" in process.env,
        decisionSigningSecret: "PAPERCLIP_DECISION_SIGNING_SECRET" in process.env,
        masterKey: "PAPERCLIP_SECRETS_MASTER_KEY" in process.env,
        masterKeyFile: "PAPERCLIP_SECRETS_MASTER_KEY_FILE" in process.env,
        handoffSecret: "PAPERCLIP_WORKSPACE_HANDOFF_SECRET" in process.env,
        runToken: process.env.PAPERCLIP_API_KEY === "synthetic-run-token",
        runId: process.env.PAPERCLIP_RUN_ID === "synthetic-run-id"
      }))`],
      {
        cwd: process.cwd(),
        env: {
          // A few preparatory launches pass a pre-merged host environment.
          BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
          PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
          PAPERCLIP_AUTH_SECRET: process.env.PAPERCLIP_AUTH_SECRET!,
          PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET!,
          PAPERCLIP_DECISION_SIGNING_SECRET: process.env.PAPERCLIP_DECISION_SIGNING_SECRET!,
          PAPERCLIP_SECRETS_MASTER_KEY: process.env.PAPERCLIP_SECRETS_MASTER_KEY!,
          PAPERCLIP_SECRETS_MASTER_KEY_FILE: process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE!,
          PAPERCLIP_WORKSPACE_HANDOFF_SECRET: process.env.PAPERCLIP_WORKSPACE_HANDOFF_SECRET!,
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
      authSecret: false,
      toolSigningSecret: false,
      decisionSigningSecret: false,
      masterKey: false,
      masterKeyFile: false,
      handoffSecret: false,
      runToken: true,
      runId: true,
    });
  });
});
