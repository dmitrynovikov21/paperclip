import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run with `node cli/node_modules/tsx/dist/cli.mjs scripts/smoke/embedded-postgres-env-e2e.ts`.
// `--expect-leak` is a negative control for the unpatched dependency.
// This script reports environment NAMES, process counts, and HTTP statuses only.
const expectLeak = process.argv.includes("--expect-leak");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir();
const testRoot = fs.mkdtempSync(path.join(scratchRoot, "paperclip-pg-env-"));
const homeDir = path.join(testRoot, "home");
const configPath = path.join(testRoot, "config.json");
const dataDir = path.join(testRoot, "db");
const instanceId = `pg-env-${randomBytes(6).toString("hex")}`;
const sensitiveNames = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_SMOKE_API_TOKEN",
] as const;

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string", "port allocation failed");
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function writeConfig(apiPort: number, dbPort: number): void {
  const config = {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "doctor" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: dataDir,
      embeddedPostgresPort: dbPort,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 7, dir: path.join(testRoot, "backups") },
    },
    logging: { mode: "file", logDir: path.join(testRoot, "logs") },
    server: {
      deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1",
      port: apiPort, allowedHostnames: [], serveUi: false,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(testRoot, "storage") },
      s3: { bucket: "unused", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted", strictMode: false,
      localEncrypted: { keyFilePath: path.join(testRoot, "secrets", "master.key") },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
}

function testServerEnv(signingSecret: string): NodeJS.ProcessEnv {
  // Do not pass this test runner's real Paperclip credentials to the child.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    PAPERCLIP_HOME: homeDir,
    PAPERCLIP_CONFIG: configPath,
    PAPERCLIP_INSTANCE_ID: instanceId,
    PAPERCLIP_AGENT_JWT_SECRET: signingSecret,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_DECISION_SIGNING_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_SMOKE_API_TOKEN: randomBytes(32).toString("hex"),
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
    HEARTBEAT_SCHEDULER_ENABLED: "false",
  };
}

async function startServer(apiPort: number, secret: string): Promise<ChildProcess> {
  const cli = path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [
    cli, path.join(repoRoot, "cli/src/index.ts"), "run",
    "--config", configPath, "--data-dir", homeDir, "--instance", instanceId,
  ], {
    cwd: repoRoot,
    env: testServerEnv(secret),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain without writing server output. A failure report never contains keys or token values.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`paperclipai run exited: status=${child.exitCode ?? child.signalCode}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
        if (response.status === 200) return child;
      } catch {
        // Startup is still in progress.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("paperclipai run health timeout");
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

async function stopServer(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("paperclipai run did not stop after SIGTERM"));
    }, 25_000);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function postgresPids(): number[] {
  const pidFile = path.join(dataDir, "postmaster.pid");
  assert(fs.existsSync(pidFile), "postmaster.pid missing");
  const masterPid = Number(fs.readFileSync(pidFile, "utf8").split("\n")[0]);
  assert(Number.isInteger(masterPid) && masterPid > 0, "invalid postmaster PID");
  const found = new Set<number>();
  const visit = (pid: number) => {
    if (found.has(pid)) return;
    found.add(pid);
    try {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
      for (const child of children.trim().split(/\s+/).filter(Boolean)) visit(Number(child));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  visit(masterPid);
  return [...found];
}

function procEnvNames(pid: number): Set<string> {
  const bytes = fs.readFileSync(`/proc/${pid}/environ`);
  const names = new Set<string>();
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0, start);
    if (end < 0) break;
    const equals = bytes.indexOf(61, start);
    if (equals > start && equals < end) names.add(bytes.subarray(start, equals).toString("utf8"));
    start = end + 1;
  }
  return names;
}

function probePostgres(): { processCount: number; leakedNames: string[]; ldLibraryPathCount: number } {
  assert(process.platform === "linux", "/proc probe requires Linux");
  const pids = postgresPids();
  const leaked = new Set<string>();
  let ldLibraryPathCount = 0;
  let processCount = 0;
  for (const pid of pids) {
    try {
      assert(fs.statSync(`/proc/${pid}`).uid === process.getuid?.(), "Postgres must share the test UID");
      const names = procEnvNames(pid);
      processCount += 1;
      if (names.has("LD_LIBRARY_PATH")) ldLibraryPathCount += 1;
      for (const name of sensitiveNames) if (names.has(name)) leaked.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert(processCount > 0, "no readable Postgres processes");
  const leakedNames = [...leaked].sort();
  console.log(`postgres_processes=${processCount} ld_library_path_processes=${ldLibraryPathCount} secret_names=${leakedNames.join(",") || "none"}`);
  return { processCount, leakedNames, ldLibraryPathCount };
}

async function postJson<T>(base: string, route: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert(response.status === 201, `${route} status=${response.status}`);
  return await response.json() as T;
}

async function agentMeStatus(base: string, token: string): Promise<number> {
  return (await fetch(`${base}/api/agents/me`, {
    headers: { authorization: `Bearer ${token}` },
  })).status;
}

type CapturedRun = { token: string; status: number };

async function startTokenCapture(): Promise<{
  url: string;
  next(): Promise<CapturedRun>;
  close(): Promise<void>;
}> {
  let pending: ((run: CapturedRun) => void) | null = null;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/capture") {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        assert(body.length < 8_192, "token capture body too large");
      }
      const run = JSON.parse(body) as CapturedRun;
      assert(typeof run.token === "string" && run.token.split(".").length === 3, "invalid captured JWT");
      assert(typeof run.status === "number", "invalid captured status");
      const claims = JSON.parse(Buffer.from(run.token.split(".")[1], "base64url").toString("utf8")) as { run_id?: unknown };
      assert(typeof claims.run_id === "string" && claims.run_id.length > 0, "JWT has no run scope");
      pending?.(run);
      pending = null;
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "capture listener has no port");
  return {
    url: `http://127.0.0.1:${address.port}/capture`,
    next: () => new Promise<CapturedRun>((resolve, reject) => {
      assert(pending === null, "capture already pending");
      const timeout = setTimeout(() => {
        pending = null;
        reject(new Error("agent run did not return a JWT"));
      }, 30_000);
      pending = (run) => {
        clearTimeout(timeout);
        resolve(run);
      };
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeAgentProbe(): string {
  const scriptPath = path.join(testRoot, "agent-probe.mjs");
  fs.writeFileSync(scriptPath, [
    'const token = process.env.PAPERCLIP_API_KEY;',
    'const response = await fetch(`${process.env.SMOKE_API_BASE}/api/agents/me`, {',
    '  headers: { authorization: `Bearer ${token}` },',
    '});',
    'await fetch(process.env.SMOKE_CAPTURE_URL, {',
    '  method: "POST", headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({ token, status: response.status }),',
    '});',
    'if (response.status !== 200) process.exitCode = 1;',
    '',
  ].join("\n"), { mode: 0o600 });
  return scriptPath;
}

async function invokeAndCapture(base: string, agentId: string, capture: Awaited<ReturnType<typeof startTokenCapture>>): Promise<CapturedRun> {
  const next = capture.next();
  const response = await fetch(`${base}/api/agents/${agentId}/heartbeat/invoke`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert(response.status === 202, `agent heartbeat invoke status=${response.status}`);
  return await next;
}

async function main(): Promise<void> {
  const apiPort = await freePort();
  let dbPort = await freePort();
  while (dbPort === apiPort) dbPort = await freePort();
  writeConfig(apiPort, dbPort);
  const base = `http://127.0.0.1:${apiPort}`;
  let child: ChildProcess | null = null;
  const capture = await startTokenCapture();
  try {
    const firstSecret = randomBytes(32).toString("hex");
    child = await startServer(apiPort, firstSecret);
    console.log("startup_1_health=200");
    const firstProbe = probePostgres();
    if (expectLeak) {
      assert(firstProbe.leakedNames.includes("PAPERCLIP_AGENT_JWT_SECRET"), "negative control did not expose JWT name");
      return;
    }
    assert(firstProbe.leakedNames.length === 0, "Postgres inherited control-plane secret names");
    assert(firstProbe.ldLibraryPathCount > 0, "Postgres lost LD_LIBRARY_PATH");

    const company = await postJson<{ id: string }>(base, "/api/companies", { name: "PG environment smoke" });
    const agent = await postJson<{ id: string }>(base, `/api/companies/${company.id}/agents`, {
      name: "PG smoke agent", role: "engineer", adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: [writeAgentProbe()],
        cwd: testRoot,
        env: { SMOKE_API_BASE: base, SMOKE_CAPTURE_URL: capture.url },
      },
    });
    const firstRun = await invokeAndCapture(base, agent.id, capture);
    const oldToken = firstRun.token;
    const firstStatus = await agentMeStatus(base, oldToken);
    console.log(`fresh_jwt_before_restart=${firstStatus}`);
    assert(firstRun.status === 200 && firstStatus === 200, "fresh run JWT did not authenticate");

    await stopServer(child);
    child = null;
    const secondSecret = randomBytes(32).toString("hex");
    child = await startServer(apiPort, secondSecret);
    console.log("startup_2_health=200");
    const secondProbe = probePostgres();
    assert(secondProbe.leakedNames.length === 0, "restarted Postgres inherited control-plane secret names");
    const staleStatus = await agentMeStatus(base, oldToken);
    const secondRun = await invokeAndCapture(base, agent.id, capture);
    const freshStatus = await agentMeStatus(base, secondRun.token);
    console.log(`stale_jwt_after_restart=${staleStatus} fresh_jwt_after_restart=${freshStatus}`);
    assert(staleStatus === 401 && secondRun.status === 200 && freshStatus === 200, "JWT rotation regression");
  } finally {
    try {
      await stopServer(child);
    } finally {
      await capture.close();
    }
    assert(!fs.existsSync(path.join(dataDir, "postmaster.pid")), "Postgres still owns the smoke fixture");
    fs.rmSync(testRoot, { recursive: true });
  }
}

await main();
