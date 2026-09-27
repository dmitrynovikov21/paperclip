// Runs only inside the disposable Bubblewrap test container. No secret values are logged.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
