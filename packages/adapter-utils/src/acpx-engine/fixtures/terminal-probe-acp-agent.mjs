#!/usr/bin/env node
// Minimal ACP agent that asks the real ACPX client to create a terminal.
// It reports only environment-name presence booleans and permission outcome.
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const variant = process.argv[2];
const markerArg = process.argv.find((arg) => arg.startsWith("--marker="));
const names = process.argv.slice(3).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
const terminalProbePath = fileURLToPath(new URL("./terminal-env-probe.mjs", import.meta.url));
const pending = new Map();
let nextId = 1000;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

function report(sessionId, report) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(report) } },
    },
  });
}

async function runTerminal(sessionId) {
  const params = {
    sessionId,
    command: process.execPath,
    args: [terminalProbePath, ...(markerArg ? [markerArg] : []), ...names],
    ...(variant === "empty" ? { env: [] } : {}),
    ...(variant === "nonempty"
      ? { env: [{ name: "ENV_PROBE_EXPLICIT", value: "client-override" }, { name: "UNLISTED_CLIENT_VAR", value: "client-only" }] }
      : {}),
  };
  let terminalId;
  try {
    const created = await request("terminal/create", params);
    terminalId = created.terminalId;
    const exited = await request("terminal/wait_for_exit", { sessionId, terminalId });
    const output = await request("terminal/output", { sessionId, terminalId });
    const result = JSON.parse(output.output);
    return { ...result, denied: false, exitOk: exited.exitCode === 0 };
  } catch {
    return { terminal: null, shell: null, denied: terminalId === undefined, exitOk: false, apiStatus: null };
  } finally {
    if (terminalId) await request("terminal/release", { sessionId, terminalId }).catch(() => {});
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.id === undefined || message.id === null) return;
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
      break;
    case "session/new":
      send({ id: message.id, result: { sessionId: "terminal-probe-session" } });
      break;
    case "session/prompt":
      void runTerminal(message.params?.sessionId).then((result) => {
        report(message.params?.sessionId, {
          agent: Object.fromEntries(names.map((name) => [name, Object.hasOwn(process.env, name)])),
          ...result,
        });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
