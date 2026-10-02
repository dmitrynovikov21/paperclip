import { randomBytes } from "node:crypto";
import inspector from "node:inspector";

const JWT_SECRET_ENV_KEY = "PAPERCLIP_AGENT_JWT_SECRET";
const EPHEMERAL_SECRET_ENV_KEY = "PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL";
let activeEphemeralSecret: string | undefined;

function ignoreSigusr1(): void {
  console.warn("[paperclip] SIGUSR1 ignored: inspector activation by signal is disabled");
}

export function closeInspectorAndInstallSignalGuard(): void {
  // This must run before reading the instance env and again before creating a signing key.
  // An inspector opened during CLI module loading would otherwise expose the new key.
  if (!process.listeners("SIGUSR1").includes(ignoreSigusr1)) {
    process.on("SIGUSR1", ignoreSigusr1);
  }
  if (inspector.url()) inspector.close();
}

export function ensureEphemeralAgentJwtSecret(): string {
  closeInspectorAndInstallSignalGuard();
  if (!activeEphemeralSecret || process.env[JWT_SECRET_ENV_KEY] !== activeEphemeralSecret) {
    activeEphemeralSecret = randomBytes(32).toString("hex");
    process.env[JWT_SECRET_ENV_KEY] = activeEphemeralSecret;
  }
  return activeEphemeralSecret;
}

// Keep the agent-JWT / session signing secret off disk.
// PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL=true in the instance env file makes `run` generate a
// fresh secret in memory on every start instead of reading or writing one in a file that any
// process of the service uid can open. Every restart therefore rotates it: outstanding run
// JWTs die with their runs, and board sessions have to log in again unless a separate
// BETTER_AUTH_SECRET is configured.
export function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function applyServerSecretHardening(): void {
  closeInspectorAndInstallSignalGuard();
  if (!isTruthyEnvFlag(process.env[EPHEMERAL_SECRET_ENV_KEY])) return;
  if (process.env[JWT_SECRET_ENV_KEY]?.trim() && process.env[JWT_SECRET_ENV_KEY] !== activeEphemeralSecret) {
    console.warn(
      `[paperclip] ${EPHEMERAL_SECRET_ENV_KEY} is set: ignoring the persistent ${JWT_SECRET_ENV_KEY}, remove it from the env file`,
    );
  }
  activeEphemeralSecret = randomBytes(32).toString("hex");
  process.env[JWT_SECRET_ENV_KEY] = activeEphemeralSecret;
}
