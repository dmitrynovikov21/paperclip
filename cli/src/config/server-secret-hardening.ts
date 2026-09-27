import { randomBytes } from "node:crypto";

const JWT_SECRET_ENV_KEY = "PAPERCLIP_AGENT_JWT_SECRET";
const EPHEMERAL_SECRET_ENV_KEY = "PAPERCLIP_AGENT_JWT_SECRET_EPHEMERAL";

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
  // A process of the same uid can send SIGUSR1 to open the Node inspector on 127.0.0.1:9229
  // and evaluate code inside the server, secrets included. With a listener installed, Node
  // does not start the inspector on that signal.
  process.on("SIGUSR1", () => {
    console.warn("[paperclip] SIGUSR1 ignored: inspector activation by signal is disabled");
  });
  if (!isTruthyEnvFlag(process.env[EPHEMERAL_SECRET_ENV_KEY])) return;
  if (process.env[JWT_SECRET_ENV_KEY]?.trim()) {
    console.warn(
      `[paperclip] ${EPHEMERAL_SECRET_ENV_KEY} is set: ignoring the persistent ${JWT_SECRET_ENV_KEY}, remove it from the env file`,
    );
  }
  process.env[JWT_SECRET_ENV_KEY] = randomBytes(32).toString("hex");
}
