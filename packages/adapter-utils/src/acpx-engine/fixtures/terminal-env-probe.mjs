#!/usr/bin/env node
// ACPX terminal child probe. The output contains names and presence booleans only.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";

const markerArg = process.argv.find((arg) => arg.startsWith("--marker="));
const names = process.argv.slice(2).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
if (markerArg) await fs.writeFile(markerArg.slice("--marker=".length), "executed");
const terminal = Object.fromEntries(names.map((name) => [name, Object.hasOwn(process.env, name)]));
const script = names
  .map((name) => `if [ "\${${name}+x}" = x ]; then printf '${name}=1\\n'; else printf '${name}=0\\n'; fi`)
  .join("\n");
const shellResult = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
const shell = Object.fromEntries(
  shellResult.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, present] = line.split("=");
    return [name, present === "1"];
  }),
);

function checkRunApi() {
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

process.stdout.write(`${JSON.stringify({ terminal, shell, shellOk: shellResult.status === 0, apiStatus: await checkRunApi() })}\n`);
