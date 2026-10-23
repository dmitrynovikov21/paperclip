import { promises as fs } from "node:fs";
import path from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** A local Git URL would let the server copy an arbitrary service-readable tree. */
export function isRemoteGitRepositoryUrl(value: string): boolean {
  const url = value.trim();
  if (url.startsWith("-")) return false;
  if (/^[^@\s/]+@[^:/\s]+:.+/.test(url)) return true; // git@host:owner/repo
  try {
    return ["https:", "http:", "ssh:", "git:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Resolve the checked host source before reading, archiving, or uploading it. */
export async function assertIsolatedWorkspaceSyncAllowed(
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME !== "true") return sourcePath;

  const hostAgentUid = Number(env.PAPERCLIP_SECRETS_HOST_AGENT_UID);
  if (process.platform !== "linux" || !Number.isSafeInteger(hostAgentUid) || hostAgentUid <= 0 ||
      hostAgentUid === process.getuid?.()) {
    throw new Error("Isolated workspace sync requires a separate non-root host agent UID.");
  }

  let configuredRoots: unknown;
  try {
    configuredRoots = JSON.parse(env.PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON ?? "[]");
  } catch {
    throw new Error("Isolated workspace sync requires a valid allowed workspace roots configuration.");
  }
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0 ||
      configuredRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("Isolated workspace sync requires absolute operator-approved workspace roots.");
  }

  const keyFilePath = env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (!keyFilePath || !path.isAbsolute(keyFilePath) || !path.isAbsolute(sourcePath)) {
    throw new Error("Isolated workspace sync requires absolute key and workspace paths.");
  }

  const secretDirectory = await fs.realpath(path.dirname(keyFilePath));
  const source = await fs.realpath(sourcePath);
  if (!(await fs.stat(source)).isDirectory()) {
    throw new Error("Isolated workspace sync requires a directory source.");
  }

  let approved = false;
  for (const configuredRoot of configuredRoots as string[]) {
    const root = await fs.realpath(configuredRoot);
    if (!(await fs.stat(root)).isDirectory() ||
        isWithin(root, secretDirectory) || isWithin(secretDirectory, root)) {
      throw new Error("Isolated workspace roots must not overlap the master-key directory.");
    }
    approved ||= isWithin(root, source);
  }
  if (!approved || isWithin(secretDirectory, source)) {
    throw new Error("Workspace source is outside the operator-approved isolated workspace roots.");
  }

  // A pathname check cannot protect a later tar -C or provider upload if the
  // agent can rename any component. Ownership matters even for a read-only
  // directory: its owner can chmod it writable after this check. Group/other
  // write also covers agent supplementary groups and POSIX ACL write masks.
  for (let directory = source; ; directory = path.dirname(directory)) {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid === hostAgentUid ||
        (entry.mode & 0o022) !== 0) {
      throw new Error(`Isolated workspace sync requires agent-immutable directory ancestors: ${directory}`);
    }
    if (directory === path.dirname(directory)) break;
  }
  return source;
}
