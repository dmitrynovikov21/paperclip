import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The smoke runs inside CI and agent processes. Keep only host context needed
// by package tools, so no live Paperclip credential can enter the probe.
const allowedHostNames = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "PAPERCLIP_RUN_SCRATCH_DIR",
]);
for (const name of Object.keys(process.env)) {
  if (!allowedHostNames.has(name)) delete process.env[name];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adapterRoot = path.join(repoRoot, "packages", "adapter-utils");
const probeAgentPath = path.join(adapterRoot, "src", "acpx-engine", "fixtures", "terminal-probe-acp-agent.mjs");
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const serverOnlyNames = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
  "PAPERCLIP_HEARTBEAT_GLOBAL_CONCURRENCY_LIMIT",
];
const expectedNames = ["PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "ENV_PROBE_EXPLICIT", "HOME", "PATH"];

async function fakeApi(runId, apiKey) {
  const server = http.createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${apiKey}`
      && request.headers["x-paperclip-run-id"] === runId;
    response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ authorized }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runProbe({ root, createExecutor, variant, permissionMode, createRuntime }) {
  const runId = `synthetic-run-${randomUUID()}`;
  const apiKey = `synthetic-key-${randomUUID()}`;
  const api = await fakeApi(runId, apiKey);
  const markerPath = path.join(root, "terminal-spawned");
  for (const name of serverOnlyNames) process.env[name] = `synthetic-${name}`;
  process.env.PAPERCLIP_RUNTIME_API_URL = api.url;
  process.env.PAPERCLIP_API_URL = api.url;
  process.env.PAPERCLIP_API_KEY = "synthetic-server-key";
  try {
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const command = [
      process.execPath, probeAgentPath, variant,
      ...(permissionMode === "deny-all" ? [`--marker=${markerPath}`] : []),
      ...serverOnlyNames, ...expectedNames, "UNLISTED_CLIENT_VAR",
    ].map(shellQuote).join(" ");
    const execute = createExecutor({ warmHandles: new Map(), ...(createRuntime ? { createRuntime } : {}) });
    const result = await execute({
      runId,
      agent: { id: "synthetic-agent", companyId: "synthetic-company" },
      runtime: {},
      config: {
        agent: "claude",
        agentCommand: command,
        stateDir: path.join(root, "state"),
        cwd,
        mode: "oneshot",
        permissionMode,
        timeoutSec: 30,
        env: { ENV_PROBE_EXPLICIT: "synthetic-explicit" },
      },
      context: {},
      authToken: apiKey,
      onLog: async () => {},
      onMeta: async () => {},
    });
    assert.equal(result.exitCode, 0, `${variant}/${permissionMode}: ACPX run failed`);
    return { report: JSON.parse(String(result.summary)), markerPath };
  } finally {
    for (const name of [...serverOnlyNames, "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY"]) {
      delete process.env[name];
    }
    await api.close();
  }
}

const scratchBase = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir();
const root = await fs.mkdtemp(path.join(scratchBase, "adapter-utils-tarball-"));
try {
  // Match the repository's release pack path: pnpm's isolated node linker
  // cannot pack bundleDependencies directly from the workspace checkout.
  const staged = path.join(root, "staged");
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "prepare-bundled-package.mjs"), adapterRoot, staged], {
    cwd: repoRoot, stdio: "pipe", timeout: 120_000,
  });
  execFileSync("npm", ["pack", "--pack-destination", root], {
    cwd: staged, stdio: "pipe", timeout: 120_000,
  });
  const archiveName = (await fs.readdir(root)).find((name) => name.endsWith(".tgz"));
  assert.ok(archiveName, "pnpm pack did not create a tarball");
  const archive = path.join(root, archiveName);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  assert.ok(entries.every((entry) => entry.startsWith("package/") && !entry.split("/").includes("..")));
  assert.ok(entries.includes("package/dist/acpx-engine/runtime.js"), "patched runtime missing from tarball");
  assert.ok(entries.includes("package/dist/acpx-engine/THIRD_PARTY_LICENSES.txt"), "bundled licenses missing from tarball");
  assert.ok(entries.includes("package/node_modules/acpx/dist/runtime.js"), "patched ACPX dependency missing from tarball");

  const consumer = path.join(root, "consumer");
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", "--registry=https://registry.npmjs.org", archive], {
    cwd: consumer, stdio: "pipe", timeout: 120_000,
  });
  const bundledAcpx = path.join(consumer, "node_modules", "@paperclipai", "adapter-utils", "node_modules", "acpx");
  const bundledAcpxPackage = JSON.parse(await fs.readFile(path.join(bundledAcpx, "package.json"), "utf8"));
  assert.equal(bundledAcpxPackage.version, "0.12.0");
  const importPath = path.join(consumer, "imports.mjs");
  await fs.writeFile(importPath, [
    'export { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";',
    `export { createAcpRuntime } from ${JSON.stringify(pathToFileURL(path.join(bundledAcpx, "dist", "runtime.js")).href)};`,
  ].join("\n"));
  const { createAcpxEngineExecutor, createAcpRuntime } = await import(pathToFileURL(importPath).href);

  for (const variant of ["absent", "empty", "nonempty"]) {
    const probeRoot = path.join(root, variant);
    await fs.mkdir(probeRoot);
    const { report } = await runProbe({ root: probeRoot, createExecutor: createAcpxEngineExecutor, variant, permissionMode: "approve-all" });
    assert.equal(report.denied, false, `${variant}: terminal was denied`);
    assert.equal(report.exitOk, true, `${variant}: terminal failed`);
    assert.equal(report.shellOk, true, `${variant}: shell failed`);
    assert.equal(report.apiStatus, 200, `${variant}: run API key did not reach terminal`);
    for (const name of serverOnlyNames) {
      assert.equal(report.agent[name], false, `${variant}: agent inherited ${name}`);
      assert.equal(report.terminal[name], false, `${variant}: terminal inherited ${name}`);
      assert.equal(report.shell[name], false, `${variant}: shell inherited ${name}`);
    }
    for (const name of expectedNames) {
      assert.equal(report.terminal[name], true, `${variant}: terminal lost ${name}`);
      assert.equal(report.shell[name], true, `${variant}: shell lost ${name}`);
    }
    assert.equal(report.terminal.UNLISTED_CLIENT_VAR, false);
    assert.equal(report.shell.UNLISTED_CLIENT_VAR, false);
  }

  const denyRoot = path.join(root, "deny-all");
  await fs.mkdir(denyRoot);
  const denied = await runProbe({ root: denyRoot, createExecutor: createAcpxEngineExecutor, variant: "absent", permissionMode: "deny-all" });
  assert.equal(denied.report.denied, true);
  assert.equal(denied.report.terminal, null);
  assert.equal(denied.report.shell, null);
  await assert.rejects(fs.access(denied.markerPath), { code: "ENOENT" });

  for (const variant of ["absent", "empty", "nonempty"]) {
    const controlRoot = path.join(root, `negative-control-${variant}`);
    await fs.mkdir(controlRoot);
    const control = await runProbe({
      root: controlRoot,
      createExecutor: createAcpxEngineExecutor,
      variant,
      permissionMode: "approve-all",
      createRuntime: (options) => {
        const withoutTerminalEnv = { ...options };
        delete withoutTerminalEnv.terminalEnv;
        return createAcpRuntime(withoutTerminalEnv);
      },
    });
    assert.equal(control.report.agent.PAPERCLIP_AGENT_JWT_SECRET, false);
    assert.equal(control.report.terminal.PAPERCLIP_AGENT_JWT_SECRET, true, `${variant}: unpatched ACPX did not reproduce inheritance`);
    assert.equal(control.report.shell.PAPERCLIP_AGENT_JWT_SECRET, true, `${variant}: unpatched ACPX shell did not reproduce inheritance`);
  }

  process.stdout.write("adapter-utils tarball: 3 env variants, deny-all, and 3 unpatched controls passed (booleans only)\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
