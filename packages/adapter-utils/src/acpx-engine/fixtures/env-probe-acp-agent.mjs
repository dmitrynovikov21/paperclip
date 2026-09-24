#!/usr/bin/env node
// Minimal ACP agent for engine tests. On a prompt it replies with one JSON
// report: which of the variable names given as arguments are set in its own
// environment and in a child shell's (the way an agent's shell tool inherits
// it), and the HTTP status of one Paperclip API call made with the run-scoped
// key. It reports booleans only and never prints a variable's value.
import http from "node:http";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const probedNames = process.argv.slice(2).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

function agentPresence() {
  return Object.fromEntries(
    probedNames.map((name) => [name, typeof process.env[name] === "string" && process.env[name].length > 0]),
  );
}

function shellPresence() {
  const script = probedNames
    .map((name) => `if [ -n "\${${name}:-}" ]; then echo "${name}=1"; else echo "${name}=0"; fi`)
    .join("\n");
  const { stdout } = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  const presence = {};
  for (const line of stdout.split("\n")) {
    const [name, flag] = line.split("=");
    if (name) presence[name] = flag === "1";
  }
  return presence;
}

function callPaperclipApi() {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = http.get(
        `${apiUrl.replace(/\/+$/, "")}/api/agents/me`,
        {
          headers: {
            authorization: `Bearer ${apiKey}`,
            "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID ?? "",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? null));
        },
      );
      request.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] },
      });
      return;
    case "session/new":
      send({ id: message.id, result: { sessionId: "env-probe-session" } });
      return;
    case "session/prompt": {
      const report = { agent: agentPresence(), shell: shellPresence(), apiStatus: await callPaperclipApi() };
      send({
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(report) } },
        },
      });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
