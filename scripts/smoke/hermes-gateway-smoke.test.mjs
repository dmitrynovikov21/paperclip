import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const joinScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-join.sh");
const e2eScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-e2e.sh");
const entrypointScript = path.join(repoRoot, "docker", "hermes-gateway-smoke", "entrypoint.sh");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function extractFunction(scriptText, name) {
  const lines = scriptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}() {`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (index > start && lines[index].trim() === "}") {
      return collected.join("\n");
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function runBashFunctions(scriptPath, functionNames, body) {
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const functions = functionNames.map((name) => extractFunction(scriptText, name)).join("\n\n");
  return run("bash", ["-c", `set -euo pipefail\n${functions}\n${body}`]);
}

test("Hermes gateway smoke shell scripts pass bash syntax validation", () => {
  const result = run("bash", ["-n", joinScript, e2eScript, entrypointScript]);
  assertSuccess(result, "bash -n");
});

test("Hermes gateway smoke help documents operator safety flags", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = run("bash", [script, "--help"]);
    assertSuccess(result, `${path.basename(script)} --help`);
    assert.match(result.stdout, /HERMES_GATEWAY_API_BASE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_PROBE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_ALLOW_INSECURE_HTTP/);
    assert.match(result.stdout, /redact|redacted|Raw .*keys are redacted/i);
  }

  const e2eHelp = run("bash", [e2eScript, "--help"]).stdout;
  assert.match(e2eHelp, /HERMES_SMOKE_KEEP/);
  assert.match(e2eHelp, /HERMES_SMOKE_NETWORK/);
  assert.match(e2eHelp, /HERMES_SMOKE_MODEL_DEFAULT/);
  assert.match(e2eHelp, /Docker/);
});

test("E2E helper can seed a minimal Hermes model config without secrets", () => {
  const result = runBashFunctions(
    e2eScript,
    ["log", "fail", "yaml_single_quote", "write_hermes_model_config"],
    `
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
HERMES_SMOKE_STATE_DIR="$tmp"
HERMES_SMOKE_MODEL_PROVIDER="openrouter"
HERMES_SMOKE_MODEL_DEFAULT="z-ai/glm-5.2"
HERMES_SMOKE_MODEL_BASE_URL="https://openrouter.ai/api/v1"
mkdir -p "$HERMES_SMOKE_STATE_DIR/hermes-home"
write_hermes_model_config
config="$HERMES_SMOKE_STATE_DIR/hermes-home/config.yaml"
grep -Fq "default: 'z-ai/glm-5.2'" "$config"
grep -Fq "provider: 'openrouter'" "$config"
grep -Fq "base_url: 'https://openrouter.ai/api/v1'" "$config"
grep -Fq "command_allowlist:" "$config"
grep -Fq -- "- execute_code" "$config"
! grep -Eiq "api[_-]?key|token|secret" "$config"
`,
  );
  assertSuccess(result, "write_hermes_model_config");
});

test("join helper redacts known secrets without exposing raw key material", () => {
  const result = runBashFunctions(
    joinScript,
    ["redact_text"],
    `
HERMES_GATEWAY_API_KEY="gateway-secret"
CLAIM_SECRET="claim-secret"
AGENT_API_KEY="agent-secret"
PAPERCLIP_API_KEY="paperclip-secret"
PAPERCLIP_AUTH_HEADER="Bearer board-secret"
PAPERCLIP_COOKIE="session=board-cookie"
output="$(redact_text "gateway-secret claim-secret agent-secret paperclip-secret Bearer board-secret session=board-cookie")"
[[ "$output" != *"gateway-secret"* ]]
[[ "$output" != *"claim-secret"* ]]
[[ "$output" != *"agent-secret"* ]]
[[ "$output" != *"paperclip-secret"* ]]
[[ "$output" != *"board-secret"* ]]
[[ "$output" != *"board-cookie"* ]]
[[ "$output" == *"[redacted len=14]"* ]]
`,
  );
  assertSuccess(result, "redact_text");
});

test("URL helpers distinguish loopback HTTP from unsafe remote HTTP", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = runBashFunctions(
      script,
      ["url_host", "is_loopback_http_host", "is_remote_plain_http"],
      `
is_remote_plain_http "http://192.168.1.20:8642"
is_remote_plain_http "http://hermes-gateway.local:8642"
is_remote_plain_http "http://127.example.com:8642"
is_remote_plain_http "http://localhost.evil:8642"
! is_remote_plain_http "https://192.168.1.20:8642"
! is_remote_plain_http "http://127.0.0.1:8642"
! is_remote_plain_http "http://127.44.55.66:8642"
! is_remote_plain_http "http://localhost:8642"
! is_remote_plain_http "http://[::1]:8642"
[[ "$(url_host "http://[::1]:8642/health")" == "::1" ]]
[[ "$(url_host "http://127.example.com:8642/health")" == "127.example.com" ]]
`,
    );
    assertSuccess(result, `${path.basename(script)} URL helpers`);
  }
});

test("join helper normalizes trailing slashes for URL comparisons", () => {
  const result = runBashFunctions(
    joinScript,
    ["strip_trailing_slash"],
    `
[[ "$(strip_trailing_slash "http://127.0.0.1:8642///")" == "http://127.0.0.1:8642" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/")" == "https://gateway.example.com" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/path/")" == "https://gateway.example.com/path" ]]
`,
  );
  assertSuccess(result, "strip_trailing_slash");
});

test("E2E diagnostic scan keeps secrets out of process args and still detects leaks", { skip: process.platform !== "linux", timeout: 10000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir(), "hermes-secret-scan-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const diagDir = path.join(tempRoot, "diagnostics");
  const binDir = path.join(tempRoot, "bin");
  const fifo = path.join(tempRoot, "pending-diagnostic");
  const script = path.join(tempRoot, "scan.sh");
  fs.mkdirSync(diagDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "find"), "#!/bin/sh\nprintf '%s\\n' \"$SCAN_TEST_FIFO\"\n", { mode: 0o755 });
  assertSuccess(run("mkfifo", [fifo]), "mkfifo");
  const scanner = extractFunction(fs.readFileSync(e2eScript, "utf8"), "scan_diagnostics_for_secret_leaks");
  fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
log() { :; }
fail() { printf 'secret detected\\n' >&2; exit 9; }
HERMES_PROVIDER_ENV_KEYS=()
AGENT_API_KEY=''
JOIN_OUTPUT_FILE=''
${scanner}
scan_diagnostics_for_secret_leaks
`);

  const marker = randomBytes(20).toString("hex");
  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    HERMES_GATEWAY_API_KEY: marker,
    HERMES_SMOKE_DIAG_DIR: diagDir,
    SCAN_TEST_FIFO: fifo,
  };
  const child = spawn("bash", [script], { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let grepPid;
  try {
    for (let attempt = 0; attempt < 60 && !grepPid; attempt += 1) {
      const processList = run("ps", ["-eo", "pid=,args="]).stdout;
      const line = processList.split("\n").find((entry) => entry.includes("grep -Fq") && entry.includes(fifo));
      if (line) grepPid = Number(line.trim().split(/\s+/)[0]);
      else await delay(50);
    }
    assert.ok(grepPid, "scanner did not reach the waiting grep process");
    const cmdline = fs.readFileSync(`/proc/${grepPid}/cmdline`, "utf8");
    const processView = run("ps", ["-p", String(grepPid), "-o", "args="]).stdout;
    assert.equal(cmdline.includes(marker), false, "synthetic secret appeared in /proc cmdline");
    assert.equal(processView.includes(marker), false, "synthetic secret appeared in ps args");

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(fifo);
      writer.once("error", reject);
      writer.end("clean diagnostics\n", resolve);
    });
    const result = await exit;
    assert.equal(result.code, 0, `clean diagnostic scan failed: ${stderr}`);
    assert.equal(stderr.includes(marker), false, "scanner printed a secret");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      if (grepPid) {
        try { process.kill(grepPid, "SIGTERM"); } catch { /* already exited */ }
      }
    }
  }

  fs.writeFileSync(path.join(diagDir, "leak.txt"), `prefix${marker}suffix\n`);
  const leak = run("bash", [script], { env: { ...env, PATH: process.env.PATH } });
  assert.equal(leak.status, 9, "scanner missed a leaked secret");
  assert.equal((leak.stdout + leak.stderr).includes(marker), false, "scanner printed a secret");
});
