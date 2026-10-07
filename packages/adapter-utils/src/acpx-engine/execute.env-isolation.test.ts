import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntime, createAgentRegistry, type AcpRuntime, type AcpRuntimeOptions } from "acpx/runtime";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  buildAcpxLaunchEnvironment,
  createAcpxEngineExecutor,
  projectAcpxInheritedHostEnvironment,
  type RuntimeCacheEntry,
} from "./execute.js";

const probeAgentPath = fileURLToPath(new URL("./fixtures/env-probe-acp-agent.mjs", import.meta.url));
const terminalProbeAgentPath = fileURLToPath(new URL("./fixtures/terminal-probe-acp-agent.mjs", import.meta.url));

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-env-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// Synthetic stand-ins for what the Paperclip server process carries in its
// environment: control-plane credentials plus plain server configuration.
function serverOnlyEnv(): Record<string, string> {
  return {
    PAPERCLIP_AGENT_JWT_SECRET: `sentinel-jwt-secret-${randomUUID()}`,
    BETTER_AUTH_SECRET: `sentinel-better-auth-secret-${randomUUID()}`,
    PAPERCLIP_SECRETS_MASTER_KEY: `sentinel-master-key-${randomUUID()}`,
    PAPERCLIP_SECRETS_MASTER_KEY_FILE: `/sentinel/master-key-${randomUUID()}`,
    PAPERCLIP_HEARTBEAT_GLOBAL_CONCURRENCY_LIMIT: `sentinel-server-config-${randomUUID()}`,
  };
}

const EXPECTED_AGENT_ENV = ["PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "ENV_PROBE_EXPLICIT", "HOME", "PATH"];

function probeCommand(serverEnv: Record<string, string>): string {
  return ["node", probeAgentPath, ...Object.keys(serverEnv), ...EXPECTED_AGENT_ENV].map(shellQuote).join(" ");
}

function terminalProbeCommand(
  serverEnv: Record<string, string>,
  variant: "absent" | "empty" | "nonempty",
  markerPath?: string,
): string {
  return [
    "node",
    terminalProbeAgentPath,
    variant,
    ...(markerPath ? [`--marker=${markerPath}`] : []),
    ...Object.keys(serverEnv),
    ...EXPECTED_AGENT_ENV,
    "UNLISTED_CLIENT_VAR",
  ].map(shellQuote).join(" ");
}

function setProcessEnv(values: Record<string, string>): () => void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function startFakePaperclipApi(input: { apiKey: string; runId: string }) {
  const requests: Array<{ path: string | undefined; authorized: boolean }> = [];
  const server = http.createServer((req, res) => {
    const authorized =
      req.headers.authorization === `Bearer ${input.apiKey}` && req.headers["x-paperclip-run-id"] === input.runId;
    requests.push({ path: req.url, authorized });
    res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(authorized ? { id: "agent-1" } : { error: "Unauthorized" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readTree(root: string): Promise<string> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const contents = await Promise.all(files.map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "utf8")));
  return contents.join("\n");
}

type ProbeReport = {
  agent: Record<string, boolean>;
  shell: Record<string, boolean>;
  apiStatus: number | null;
};

type TerminalProbeReport = {
  agent: Record<string, boolean>;
  terminal: Record<string, boolean> | null;
  shell: Record<string, boolean> | null;
  shellOk?: boolean;
  denied: boolean;
  exitOk: boolean;
  apiStatus: number | null;
};

async function runProbe<TReport = ProbeReport>(input: {
  root: string;
  serverEnv: Record<string, string>;
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  agentCommand?: string;
  permissionMode?: "approve-all" | "deny-all";
  mode?: "persistent" | "oneshot";
  warmHandles?: Map<string, RuntimeCacheEntry>;
  sessionParams?: Record<string, unknown>;
}) {
  const runId = `run-${randomUUID()}`;
  const apiKey = `run-scoped-key-${randomUUID()}`;
  const api = await startFakePaperclipApi({ apiKey, runId });
  // Point every API variable the server process could hold at the fake API, so
  // no probe ever reaches a real Paperclip instance with a real key.
  const restoreEnv = setProcessEnv({
    ...input.serverEnv,
    PAPERCLIP_RUNTIME_API_URL: api.url,
    PAPERCLIP_API_URL: api.url,
    PAPERCLIP_API_KEY: `server-process-key-${randomUUID()}`,
  });
  const logs: string[] = [];
  const meta: unknown[] = [];
  try {
    const cwd = path.join(input.root, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const execute = createAcpxEngineExecutor({ warmHandles: input.warmHandles ?? new Map(), createRuntime: input.createRuntime });
    const result = await execute({
      runId,
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: input.sessionParams ? { sessionParams: input.sessionParams } : {},
      config: {
        agent: "claude",
        agentCommand: input.agentCommand ?? probeCommand(input.serverEnv),
        stateDir: path.join(input.root, "state"),
        cwd,
        mode: input.mode ?? "oneshot",
        warmHandleIdleMs: input.mode === "persistent" ? 60_000 : undefined,
        permissionMode: input.permissionMode,
        env: { ENV_PROBE_EXPLICIT: "explicit-adapter-env" },
      },
      context: {},
      authToken: apiKey,
      onLog: async (_stream: "stdout" | "stderr", text: string) => {
        logs.push(text);
      },
      onMeta: async (payload: unknown) => {
        meta.push(payload);
      },
    } as never);
    expect(result.exitCode).toBe(0);
    const persisted = [logs.join(""), JSON.stringify(meta), JSON.stringify(result), await readTree(input.root)].join("\n");
    return {
      report: JSON.parse(String(result.summary)) as TReport,
      apiRequests: api.requests,
      persisted,
      sessionParams: result.sessionParams,
    };
  } finally {
    restoreEnv();
    await api.close();
  }
}

describe("ACPX agent launch environment", () => {
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    https_proxy: "http://proxy.local:3128",
    ANTHROPIC_API_KEY: "anthropic-provider-key",
    OPENAI_API_KEY: "openai-provider-key",
    PAPERCLIP_AGENT_JWT_SECRET: "jwt-signing-secret",
    BETTER_AUTH_SECRET: "better-auth-secret",
    PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/secrets/master.key",
    PAPERCLIP_LISTEN_PORT: "3100",
    SONIOX_API_KEY: "unrelated-service-key",
    INVOCATION_ID: "systemd-invocation-id",
  };
  const hostContext = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    https_proxy: "http://proxy.local:3128",
  };

  it("inherits only host context and the agent's own provider credentials", () => {
    expect(projectAcpxInheritedHostEnvironment(hostEnv, "claude")).toEqual({
      ...hostContext,
      ANTHROPIC_API_KEY: "anthropic-provider-key",
    });
    expect(projectAcpxInheritedHostEnvironment(hostEnv, "codex")).toEqual({
      ...hostContext,
      OPENAI_API_KEY: "openai-provider-key",
    });
    expect(projectAcpxInheritedHostEnvironment(hostEnv, "custom")).toEqual(hostContext);
  });

  it("drops server-only credentials even when adapter env names them", () => {
    const launchEnv = buildAcpxLaunchEnvironment(
      {
        PAPERCLIP_API_KEY: "run-scoped-key",
        PAPERCLIP_AGENT_JWT_SECRET: "explicit-signing-secret",
        BETTER_AUTH_SECRET: "explicit-better-auth-secret",
        TOOL_TOKEN: "adapter-tool-token",
      },
      "claude",
      hostEnv,
    );
    expect(launchEnv).toEqual({
      ...hostContext,
      ANTHROPIC_API_KEY: "anthropic-provider-key",
      PAPERCLIP_API_KEY: "run-scoped-key",
      TOOL_TOKEN: "adapter-tool-token",
    });
  });

  it("gives the agent a default PATH when the host has none", () => {
    expect(buildAcpxLaunchEnvironment({}, "claude", {}).PATH).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")(
    "launches the agent and its shell tool without the server's environment, keeping the run-scoped key",
    async () => {
      const root = await makeTempRoot();
      const serverEnv = serverOnlyEnv();
      const { report, apiRequests, persisted } = await runProbe({ root, serverEnv });

      for (const name of Object.keys(serverEnv)) {
        expect(report.agent[name], `agent sees ${name}`).toBe(false);
        expect(report.shell[name], `agent shell sees ${name}`).toBe(false);
      }
      for (const name of EXPECTED_AGENT_ENV) {
        expect(report.agent[name], `agent sees ${name}`).toBe(true);
        expect(report.shell[name], `agent shell sees ${name}`).toBe(true);
      }
      expect(report.apiStatus).toBe(200);
      expect(apiRequests).toEqual([{ path: "/api/agents/me", authorized: true }]);
      for (const value of Object.values(serverEnv)) {
        expect(persisted.includes(value)).toBe(false);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "direct ACPX launch stays isolated without the old Paperclip wrapper",
    async () => {
      const root = await makeTempRoot();
      const serverEnv = serverOnlyEnv();
      // Master launches the ACPX agent directly. The patched runtime must use
      // the explicit launch env even without the old Paperclip wrapper.
      const { report } = await runProbe({
        root,
        serverEnv,
        createRuntime: (options) =>
          createAcpRuntime({
            ...options,
            agentRegistry: createAgentRegistry({ overrides: { claude: probeCommand(serverEnv) } }),
          }),
      });

      expect(report.agent.PAPERCLIP_AGENT_JWT_SECRET).toBe(false);
      expect(report.shell.PAPERCLIP_AGENT_JWT_SECRET).toBe(false);
      expect(report.apiStatus).toBe(200);
    },
    30_000,
  );

  for (const variant of ["absent", "empty", "nonempty"] as const) {
    it.skipIf(process.platform === "win32")(
      `terminal/create with ${variant} env gives the terminal and its shell only host/run names`,
      async () => {
        const root = await makeTempRoot();
        const serverEnv = serverOnlyEnv();
        const { report, persisted } = await runProbe<TerminalProbeReport>({
          root,
          serverEnv,
          agentCommand: terminalProbeCommand(serverEnv, variant),
          permissionMode: "approve-all",
        });

        expect(report.denied).toBe(false);
        expect(report.exitOk).toBe(true);
        expect(report.shellOk).toBe(true);
        expect(report.apiStatus).toBe(200);
        for (const name of Object.keys(serverEnv)) {
          expect(report.agent[name], `agent sees ${name}`).toBe(false);
          expect(report.terminal?.[name], `terminal sees ${name}`).toBe(false);
          expect(report.shell?.[name], `terminal shell sees ${name}`).toBe(false);
        }
        for (const name of EXPECTED_AGENT_ENV) {
          expect(report.terminal?.[name], `terminal sees ${name}`).toBe(true);
          expect(report.shell?.[name], `terminal shell sees ${name}`).toBe(true);
        }
        expect(report.terminal?.UNLISTED_CLIENT_VAR).toBe(false);
        expect(report.shell?.UNLISTED_CLIENT_VAR).toBe(false);
        for (const value of Object.values(serverEnv)) {
          expect(persisted.includes(value)).toBe(false);
        }
      },
      30_000,
    );
  }

  it.skipIf(process.platform === "win32")(
    "control: unpatched ACPX terminal/create inherits server-only names with absent, empty and nonempty env",
    async () => {
      for (const variant of ["absent", "empty", "nonempty"] as const) {
        const root = await makeTempRoot();
        const serverEnv = serverOnlyEnv();
        const { report } = await runProbe<TerminalProbeReport>({
          root,
          serverEnv,
          agentCommand: terminalProbeCommand(serverEnv, variant),
          permissionMode: "approve-all",
          createRuntime: (options) => {
            const unpatchedOptions = { ...options } as AcpRuntimeOptions & { terminalEnv?: Record<string, string> };
            delete unpatchedOptions.terminalEnv;
            return createAcpRuntime(unpatchedOptions);
          },
        });
        expect(report.agent.PAPERCLIP_AGENT_JWT_SECRET).toBe(false);
        expect(report.terminal?.PAPERCLIP_AGENT_JWT_SECRET).toBe(true);
        expect(report.shell?.PAPERCLIP_AGENT_JWT_SECRET).toBe(true);
        expect(report.apiStatus).toBe(401);
      }
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "deny-all rejects terminal/create without launching a child",
    async () => {
      const root = await makeTempRoot();
      const serverEnv = serverOnlyEnv();
      const markerPath = path.join(root, "terminal-executed");
      const { report } = await runProbe<TerminalProbeReport>({
        root,
        serverEnv,
        agentCommand: terminalProbeCommand(serverEnv, "absent", markerPath),
        permissionMode: "deny-all",
      });
      expect(report.denied).toBe(true);
      expect(report.terminal).toBeNull();
      expect(report.shell).toBeNull();
      await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "a warm ACPX runtime gives the terminal the current run's API key",
    async () => {
      const root = await makeTempRoot();
      const serverEnv = serverOnlyEnv();
      const warmHandles = new Map<string, RuntimeCacheEntry>();
      const command = terminalProbeCommand(serverEnv, "absent");
      try {
        const first = await runProbe<TerminalProbeReport>({
          root,
          serverEnv,
          agentCommand: command,
          permissionMode: "approve-all",
          mode: "persistent",
          warmHandles,
        });
        expect(first.report.apiStatus).toBe(200);
        expect(first.sessionParams).toBeTruthy();
        expect(warmHandles.size).toBe(1);

        const second = await runProbe<TerminalProbeReport>({
          root,
          serverEnv,
          agentCommand: command,
          permissionMode: "approve-all",
          mode: "persistent",
          warmHandles,
          sessionParams: first.sessionParams ?? undefined,
        });
        expect(second.report.apiStatus).toBe(200);
        expect(second.report.terminal?.PAPERCLIP_AGENT_JWT_SECRET).toBe(false);
        expect(warmHandles.size).toBe(1);
      } finally {
        await Promise.all([...warmHandles.values()].map(async (entry) => {
          if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
          await entry.runtime.close({ handle: entry.handle, reason: "test cleanup", discardPersistentState: true }).catch(() => {});
        }));
        warmHandles.clear();
      }
    },
    60_000,
  );
});
