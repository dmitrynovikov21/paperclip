// Runs only inside the disposable Bubblewrap test container. No secret values are logged.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildLocalProcessSandboxSpawnTarget } from "../../packages/adapter-utils/src/local-process-sandbox.js";
import {
  assertFileBackedDbAgentExecutionAllowed,
  runAdapterExecutionTargetProcess,
} from "../../packages/adapter-utils/src/execution-target.js";
import { buildPaperclipEnv } from "../../packages/adapter-utils/src/server-utils.js";

const workspaceDir = process.env.WORKSPACE_DIR;
const credentialPath = process.env.PAPERCLIP_DATABASE_URL_FILE;
const apiKey = process.env.PAPERCLIP_API_KEY;
const runId = process.env.PAPERCLIP_RUN_ID;
const agentId = process.env.EXPECTED_AGENT_ID;
const companyId = process.env.PAPERCLIP_COMPANY_ID;
if (!workspaceDir || !credentialPath || !apiKey || !runId || !agentId || !companyId ||
    !process.env.PAPERCLIP_AGENT_JWT_SECRET) {
  throw new Error("Missing synthetic service source or run identity");
}
const serviceUrl = readFileSync(credentialPath, "utf8").trim();
if (!serviceUrl.startsWith("postgres://")) {
  throw new Error("Synthetic service credential is not readable before agent launch");
}

const env = {
  ...buildPaperclipEnv({ id: agentId, companyId }),
  PAPERCLIP_API_KEY: apiKey,
  PAPERCLIP_RUN_ID: runId,
  EXPECTED_AGENT_ID: agentId,
  EXPECTED_SERVICE_UID: String(process.getuid?.() ?? -1),
  KNOWN_CREDENTIAL_PATH: credentialPath,
  EXPECTED_CREDENTIAL_VISIBILITY: "hidden",
};
const target = { kind: "local" } as const;
const options = {
  cwd: workspaceDir,
  env,
  timeoutSec: 20,
  graceSec: 2,
  onLog: async () => {},
};

for (const [label, attempt] of [
  ["unconfined local", () => runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], options)],
  ["local network-only", () => runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options, localProcessSandbox: { workspaceDir, networkScope: "deny" as const },
  })],
] as const) {
  try {
    await attempt();
    throw new Error(`${label} unexpectedly launched`);
  } catch (error) {
    if (!String(error).includes("require a workspace filesystem sandbox")) throw error;
  }
  console.log(`${label}: denied before agent launch`);
}
try {
  assertFileBackedDbAgentExecutionAllowed(target, null, "acpx");
  throw new Error("local ACPX unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("require ACPX to run in an isolated remote environment")) throw error;
}
console.log("unconfined ACPX: denied before agent launch");

try {
  await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options,
    env: { ...env, PAPERCLIP_DATABASE_URL_FILE: credentialPath },
    localProcessSandbox: { workspaceDir, filesystemScope: "workspace" },
  });
  throw new Error("explicit database source unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("must not contain control-plane database or signing credentials")) throw error;
}
console.log("explicit DB source: denied before agent launch");

try {
  await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options,
    localProcessSandbox: {
      workspaceDir,
      filesystemScope: "workspace",
      extraPaths: [{ path: dirname(credentialPath), access: "ro" }],
    },
  });
  throw new Error("credential mount unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("mount would expose the service database credential")) throw error;
}
console.log("credential-bearing mount: denied before agent launch");

try {
  await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options,
    localProcessSandbox: { workspaceDir, filesystemScope: "workspace", command: join(workspaceDir, "missing-bwrap") },
  });
  throw new Error("missing Bubblewrap unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("requires Bubblewrap")) throw error;
}
console.log("missing Bubblewrap: denied before agent launch");

const result = await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
  ...options,
  localProcessSandbox: { workspaceDir, filesystemScope: "workspace" },
});
if (result.exitCode !== 0 || !result.stdout.includes("Launched agent: credential read denied; DB/signing env keys 0; JWT API HTTP 200")) {
  const diagnostic = result.stderr.replaceAll(serviceUrl, "[redacted database URL]")
    .replaceAll(new URL(serviceUrl).password, "[redacted password]")
    .replaceAll(apiKey, "[redacted API token]")
    .replaceAll(process.env.PAPERCLIP_AGENT_JWT_SECRET!, "[redacted signing key]")
    .split("\n").filter(Boolean).slice(-5).join("; ");
  throw new Error(`workspace sandbox agent check failed (exit ${result.exitCode ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
}
console.log("workspace sandbox: credential path hidden; DB/signing env keys 0; JWT API HTTP 200");

const aliasSource = join(workspaceDir, "alias-source");
const preservedAlias = join(workspaceDir, "preserved-alias-source");
await fs.mkdir(aliasSource);
await fs.writeFile(join(aliasSource, "allowed-marker"), "safe");
const aliasTarget = await buildLocalProcessSandboxSpawnTarget({
  executable: "/usr/bin/python3",
  args: ["-c", `from pathlib import Path
alias = Path('/checked-alias')
if (alias / 'allowed-marker').read_text() != 'safe':
    raise RuntimeError('alias did not bind the checked directory')
if (alias / 'database-url').exists():
    raise RuntimeError('alias exposed the service credential')
print('alias race: pinned directory visible; credential read denied')`],
  cwd: workspaceDir,
  options: {
    workspaceDir,
    filesystemScope: "workspace",
    pathAliases: [{ path: "/checked-alias", target: aliasSource }],
  },
});
try {
  // Swap the canonical source after target construction and before bwrap spawn.
  await fs.rename(aliasSource, preservedAlias);
  await fs.symlink(dirname(credentialPath), aliasSource);
  const aliasResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(aliasTarget.command, aliasTarget.args, {
      cwd: aliasTarget.cwd,
      env: { PATH: "/usr/bin:/bin", HOME: workspaceDir },
      stdio: ["ignore", "pipe", "pipe", ...(aliasTarget.inheritedFds ?? [])],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (aliasResult.code !== 0 || !aliasResult.stdout.includes("alias race: pinned directory visible; credential read denied")) {
    throw new Error(`alias race sandbox failed (exit ${aliasResult.code ?? "unknown"}): ${aliasResult.stderr.slice(-400)}`);
  }
  console.log("alias race: pinned directory visible; credential read denied");
} finally {
  await aliasTarget.cleanup?.();
  await fs.rm(aliasSource, { recursive: true, force: true });
  await fs.rm(preservedAlias, { recursive: true, force: true });
}
