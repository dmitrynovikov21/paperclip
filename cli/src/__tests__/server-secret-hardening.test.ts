import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAgentJwtSecret, resolveAgentJwtEnvFile } from "../config/env.js";
import { applyServerSecretHardening, isTruthyEnvFlag } from "../config/server-secret-hardening.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../../../server/src/agent-auth-jwt.js";

const doctorMock = vi.hoisted(() => vi.fn());

vi.mock("../commands/doctor.js", () => ({ doctor: doctorMock }));

const ORIGINAL_ENV = { ...process.env };
const HARDENING_MODULE = fileURLToPath(new URL("../config/server-secret-hardening.ts", import.meta.url));
const EARLY_GUARD_MODULE = fileURLToPath(new URL("../config/early-inspector-guard.ts", import.meta.url));
const SYNTHETIC_PERSISTENT_SECRET = "synthetic-persistent-secret-for-tests";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tempConfigPath(): string {
  const configDir = path.join(tempDir("paperclip-secret-hardening-"), "instance");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, "{}\n");
  return configPath;
}

function removeAddedSigusr1Listeners(before: Function[]): void {
  for (const listener of process.listeners("SIGUSR1")) {
    if (!before.includes(listener)) process.removeListener("SIGUSR1", listener as () => void);
  }
}

describe("server secret hardening", () => {
  let sigusr1ListenersBefore: Function[];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL;
    sigusr1ListenersBefore = process.listeners("SIGUSR1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    removeAddedSigusr1Listeners(sigusr1ListenersBefore);
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    doctorMock.mockReset();
  });

  it("parses the ephemeral flag like other boolean env flags", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) expect(isTruthyEnvFlag(value)).toBe(true);
    for (const value of [undefined, "", "0", "false", "no", "off", "enabled"]) expect(isTruthyEnvFlag(value)).toBe(false);
  });

  it("keeps the persistent secret when the ephemeral flag is not set", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = SYNTHETIC_PERSISTENT_SECRET;

    applyServerSecretHardening();

    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe(SYNTHETIC_PERSISTENT_SECRET);
  });

  it("installs a SIGUSR1 listener whether or not the flag is set", () => {
    applyServerSecretHardening();

    expect(process.listeners("SIGUSR1").length).toBe(sigusr1ListenersBefore.length + 1);
  });

  it("replaces a persistent secret with a fresh in-memory one and warns", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL = "true";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = SYNTHETIC_PERSISTENT_SECRET;

    applyServerSecretHardening();

    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("ignoring the persistent PAPERCLIP_AGENT_JWT_SECRET"));
  });

  it("generates a different secret on every start", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL = "true";
    applyServerSecretHardening();
    const first = process.env.PAPERCLIP_AGENT_JWT_SECRET;

    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    applyServerSecretHardening();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).not.toBe(first);
  });

  it("stops the doctor repair from writing a secret into the env file", () => {
    const configPath = tempConfigPath();
    process.env.PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL = "true";

    applyServerSecretHardening();
    const result = ensureAgentJwtSecret(configPath);

    expect(result.created).toBe(false);
    expect(result.secret).toBe(process.env.PAPERCLIP_AGENT_JWT_SECRET);
    expect(fs.existsSync(resolveAgentJwtEnvFile(configPath))).toBe(false);
  });

  it("negative control: without the flag the doctor repair writes the secret into the env file", () => {
    const configPath = tempConfigPath();

    applyServerSecretHardening();
    const result = ensureAgentJwtSecret(configPath);

    expect(result.created).toBe(true);
    expect(fs.readFileSync(resolveAgentJwtEnvFile(configPath), "utf-8")).toContain("PAPERCLIP_AGENT_JWT_SECRET=");
  });

  it("runCommand applies it after loading the env file and before doctor", async () => {
    const home = tempDir("paperclip-secret-hardening-home-");
    process.env.HOME = home;
    process.env.PAPERCLIP_HOME = path.join(home, ".paperclip");
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    fs.writeFileSync(
      envPath,
      `PAPERCLIP_AGENT_JWT_SECRET=${SYNTHETIC_PERSISTENT_SECRET}\nPAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL=true\n`,
      { mode: 0o600 },
    );
    const envFileBefore = fs.readFileSync(envPath, "utf-8");
    let secretSeenByDoctor: string | undefined;
    doctorMock.mockImplementation(async () => {
      secretSeenByDoctor = process.env.PAPERCLIP_AGENT_JWT_SECRET;
      return { passed: 0, warned: 0, failed: 1 };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runCommand } = await import("../commands/run.js");

    await expect(runCommand({ config: configPath })).rejects.toThrow("process.exit(1)");

    expect(doctorMock).toHaveBeenCalledTimes(1);
    expect(secretSeenByDoctor).toMatch(/^[0-9a-f]{64}$/);
    expect(secretSeenByDoctor).not.toBe(SYNTHETIC_PERSISTENT_SECRET);
    expect(fs.readFileSync(envPath, "utf-8")).toBe(envFileBefore);
    expect(process.listeners("SIGUSR1").length).toBe(sigusr1ListenersBefore.length + 1);
  });

  it("passes an in-memory key to the server signer and invalidates its run JWT on rotation", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL=true\n", { mode: 0o600 });

    ensureAgentJwtSecret(configPath);
    const token = createLocalAgentJwt("synthetic-agent", "synthetic-company", "codex_local", "synthetic-run");
    expect(token).not.toBeNull();
    expect(verifyLocalAgentJwt(token!)?.run_id).toBe("synthetic-run");
    expect(fs.readFileSync(envPath, "utf8")).toBe("PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL=true\n");

    applyServerSecretHardening();
    expect(verifyLocalAgentJwt(token!)).toBeNull();
    const nextToken = createLocalAgentJwt("synthetic-agent", "synthetic-company", "codex_local", "next-run");
    expect(verifyLocalAgentJwt(nextToken!)?.run_id).toBe("next-run");
  });
});

async function inspectorOpenAfterSigusr1(applyHardening: boolean): Promise<boolean> {
  const script = [
    `import inspector from "node:inspector";`,
    applyHardening
      ? `const { applyServerSecretHardening } = await import(${JSON.stringify(HARDENING_MODULE)}); applyServerSecretHardening();`
      : "",
    `process.kill(process.pid, "SIGUSR1");`,
    `setTimeout(() => { console.log(JSON.stringify({ open: Boolean(inspector.url()) })); process.exit(0); }, 1500);`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--inspect-port=127.0.0.1:0", "--import", "tsx", "--input-type=module", "-e", script],
    { cwd: path.dirname(HARDENING_MODULE), env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  const line = stdout.trim().split("\n").pop() ?? "";
  return (JSON.parse(line) as { open: boolean }).open;
}

describe("SIGUSR1 inspector activation", () => {
  it("installs the CLI entry guard before a later signal can open the inspector", async () => {
    const script = [
      `import inspector from "node:inspector";`,
      `await import(${JSON.stringify(EARLY_GUARD_MODULE)});`,
      `process.kill(process.pid, "SIGUSR1");`,
      `setTimeout(() => console.log(JSON.stringify({ open: Boolean(inspector.url()) })), 300);`,
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--inspect-port=127.0.0.1:0", "--import", "tsx", "--input-type=module", "-e", script],
      { cwd: path.dirname(HARDENING_MODULE), env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").pop() ?? "{}")).toEqual({ open: false });
  }, 20_000);

  it("does not open the inspector once hardening is applied", async () => {
    expect(await inspectorOpenAfterSigusr1(true)).toBe(false);
  }, 20_000);

  it("negative control: opens the inspector without hardening", async () => {
    expect(await inspectorOpenAfterSigusr1(false)).toBe(true);
  }, 20_000);

  it("closes an inspector opened before hardening and before creating a signing key", async () => {
    const script = [
      `import inspector from "node:inspector";`,
      `import crypto from "node:crypto";`,
      `import { syncBuiltinESMExports } from "node:module";`,
      `process.env.PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL = "true";`,
      `process.kill(process.pid, "SIGUSR1");`,
      `await new Promise((resolve) => setTimeout(resolve, 300));`,
      `const openedBefore = Boolean(inspector.url());`,
      `let openAtKeyCreation = null;`,
      `const randomBytes = crypto.randomBytes;`,
      `crypto.randomBytes = (...args) => { openAtKeyCreation = Boolean(inspector.url()); return randomBytes(...args); };`,
      `syncBuiltinESMExports();`,
      `const { applyServerSecretHardening } = await import(${JSON.stringify(HARDENING_MODULE)});`,
      `applyServerSecretHardening();`,
      `console.log(JSON.stringify({ openedBefore, openAtKeyCreation, openAfter: Boolean(inspector.url()), keyCreated: /^[0-9a-f]{64}$/.test(process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "") }));`,
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--inspect-port=127.0.0.1:0", "--import", "tsx", "--input-type=module", "-e", script],
      { cwd: path.dirname(HARDENING_MODULE), env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").pop() ?? "{}")).toEqual({
      openedBefore: true,
      openAtKeyCreation: false,
      openAfter: false,
      keyCreated: true,
    });
  }, 20_000);
});
