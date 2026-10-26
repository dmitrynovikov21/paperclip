// One-shot synthetic HTTP check against a real server with a file-backed DB URL.
// It prints statuses only; never the credential, JWT, or operation command.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  runAdapterExecutionTargetProcess,
  type AdapterSandboxExecutionTarget,
} from "../../packages/adapter-utils/src/execution-target.js";
import { runChildProcess } from "../../packages/adapter-utils/src/server-utils.js";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  resolveDatabaseConnectionString,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../src/agent-auth-jwt.js";

const apiUrl = process.argv[2];
const fixtureDir = process.argv[3];
if (!apiUrl || !/^http:\/\/(?:127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3}):\d+$/.test(apiUrl) || !fixtureDir) {
  throw new Error("Expected a synthetic API URL and fixture directory");
}
const credentialPath = process.env.PAPERCLIP_DATABASE_URL_FILE;
const dbUrl = resolveDatabaseConnectionString({});
if (!dbUrl || !credentialPath || process.env.DATABASE_URL) {
  throw new Error("Expected a file-backed DB source without DATABASE_URL");
}

const db = createDb(dbUrl);
try {
  const [company] = await db.insert(companies).values({
    name: "Synthetic host workspace boundary",
    issuePrefix: `SH${randomUUID().replace(/-/g, "").slice(0, 8)}`,
  }).returning({ id: companies.id });
  if (!company) throw new Error("Company seed failed");
  const [agent] = await db.insert(agents).values({
    companyId: company.id, name: "Synthetic workspace agent", role: "general",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
  }).returning({ id: agents.id });
  if (!agent) throw new Error("Agent seed failed");
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId, companyId: company.id, agentId: agent.id, status: "running",
  });
  const jwt = createLocalAgentJwt(agent.id, company.id, "codex_local", runId);
  if (!jwt) throw new Error("Run-scoped JWT issuance failed");

  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const executionWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const hostReadMarker = join(fixtureDir, "host-read-marker");
  const provisionMarker = join(fixtureDir, "host-provision-marker");
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const readCredential = `cat ${shellQuote(credentialPath)} > ${shellQuote(hostReadMarker)}`;
  await db.insert(projects).values({
    id: projectId, companyId: company.id, name: "Synthetic host boundary", status: "in_progress",
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId, companyId: company.id, projectId, name: "Synthetic workspace",
    sourceType: "local_path", cwd: join(fixtureDir, "workspace"), isPrimary: true,
  });
  await db.insert(issues).values({
    id: issueId, companyId: company.id, projectId, projectWorkspaceId,
    identifier: `SYN-${randomUUID().slice(0, 8)}`, title: "Synthetic runtime control",
    status: "in_progress", priority: "medium", assigneeAgentId: agent.id,
  });
  await db.insert(executionWorkspaces).values({
    id: executionWorkspaceId, companyId: company.id, projectId, projectWorkspaceId,
    sourceIssueId: issueId, mode: "shared_workspace", strategyType: "project_primary",
    name: "Synthetic runtime workspace", status: "active", providerType: "local_fs",
    cwd: join(fixtureDir, "workspace"),
    metadata: {
      source: "project_primary",
      config: {
        runtimeProvisionCommand: `touch ${shellQuote(provisionMarker)}`,
        workspaceRuntime: {
          jobs: [{ name: "read-credential", command: readCredential }],
          services: [{ name: "read-credential-service", command: readCredential }],
        },
      },
    },
  });
  await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));

  const post = (route: string, body: Record<string, unknown>) =>
    fetch(`${apiUrl}/api/execution-workspaces/${executionWorkspaceId}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const runResponse = await post("runtime-commands/run", { workspaceCommandId: "job:read-credential" });
  const startResponse = await post("runtime-services/start", { workspaceCommandId: "service:read-credential-service" });
  if (runResponse.status !== 403 || startResponse.status !== 403) {
    throw new Error(`Host workspace HTTP denial mismatch: run=${runResponse.status}, start=${startResponse.status}`);
  }
  const operationsResponse = await fetch(`${apiUrl}/api/execution-workspaces/${executionWorkspaceId}/workspace-operations`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!operationsResponse.ok) throw new Error(`Host workspace operation lookup failed: HTTP ${operationsResponse.status}`);
  const operations = await operationsResponse.json() as Array<{ status: string; stderrExcerpt?: string | null }>;
  if (operations.filter((operation) =>
    operation.status === "failed" && operation.stderrExcerpt?.includes("File-backed database credentials forbid host")
  ).length < 2 || existsSync(hostReadMarker) || existsSync(provisionMarker)) {
    throw new Error("Host workspace HTTP denial did not fail closed before credential read or provision");
  }

  const teardownWorkspaceId = randomUUID();
  const teardownWorkspaceDir = join(fixtureDir, "teardown-workspace");
  mkdirSync(teardownWorkspaceDir);
  await db.insert(executionWorkspaces).values({
    id: teardownWorkspaceId, companyId: company.id, projectId,
    mode: "isolated_workspace", strategyType: "project_primary", name: "Synthetic teardown",
    status: "active", providerType: "local_fs", cwd: teardownWorkspaceDir, providerRef: teardownWorkspaceDir,
    metadata: { createdByRuntime: true, config: { teardownCommand: readCredential } },
  });
  const teardownResponse = await fetch(`${apiUrl}/api/execution-workspaces/${teardownWorkspaceId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "archived" }),
  });
  const teardownResult = await teardownResponse.json() as { cleanupReason?: string | null };
  if (!teardownResponse.ok || !teardownResult.cleanupReason?.includes("File-backed database credentials forbid host workspace commands") ||
      existsSync(hostReadMarker)) {
    throw new Error(`Host workspace teardown did not fail closed: HTTP ${teardownResponse.status}`);
  }
  console.log("Host workspace HTTP boundary: run/start denied, provision/teardown skipped, credential marker 0");

  const controlImage = process.env.PAPERCLIP_E2E_REMOTE_CONTROL_IMAGE?.trim();
  if (controlImage) {
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/probe",
      runner: {
        execute: (input) => runChildProcess(`${runId}-remote-control`, "docker", [
          "run", "--rm", "--network", "none", "--user", "65534:65534",
          "--mount", `type=bind,src=${join(fixtureDir, "workspace")},dst=/probe,readonly`,
          "--workdir", "/probe", "--env", "PAPERCLIP_API_URL",
          controlImage, input.command, ...(input.args ?? []),
        ], {
          cwd: fixtureDir,
          env: input.env ?? {},
          timeoutSec: 20,
          graceSec: 2,
          onLog: async () => {},
        }),
      },
    };
    const result = await runAdapterExecutionTargetProcess(`${runId}-remote-control`, target, "sh", [
      "-c", "test \"$(id -u)\" = 65534 && test ! -e /probe/database-url && test -z \"${PAPERCLIP_DATABASE_URL_FILE:-}\" && printf isolated-ok",
    ], {
      cwd: fixtureDir,
      env: { PAPERCLIP_API_URL: apiUrl },
      timeoutSec: 20,
      graceSec: 2,
      onLog: async () => {},
    });
    if (result.exitCode !== 0 || !result.stdout.includes("isolated-ok")) {
      throw new Error(`Isolated remote control failed: exit=${result.exitCode ?? "unknown"}`);
    }
    console.log("Isolated remote sandbox control: separate UID, credential path absent, exit 0");
  }
} finally {
  await db.$client.end();
}
