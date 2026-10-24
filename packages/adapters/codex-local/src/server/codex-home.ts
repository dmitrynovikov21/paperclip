import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import {
  type SafeHandle,
  lstatChild,
  listPinnedDirectory,
  openChildNoFollow,
  openDirectoryNoFollow,
  openPathNoFollow,
  readChildLink,
  readRegularFileNoFollow,
  replaceRegularFileNoFollow,
} from "./safe-home-files.js";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const MANAGED_MCP_BLOCK_START = "# BEGIN PAPERCLIP MANAGED MCP";
const MANAGED_MCP_BLOCK_END = "# END PAPERCLIP MANAGED MCP";

/**
 * The allowlist of managed `CODEX_HOME` entries that the codex-local adapter
 * stages into the sandbox `home` asset (see {@link stageCodexHomeForSync}).
 * Derived from the seeding constants so it can never drift from what the adapter
 * actually writes into the home: the copied static config files, the symlinked
 * credential file, and the injected `skills/` directory. Everything else the
 * stock upstream `codex` binary writes at runtime (`*.sqlite`, `*-wal`,
 * `plugins/`, `cache/`, `sessions/`, `shell_snapshots/`, …) is intentionally
 * excluded — it is large host-local runtime state the sandbox run never needs.
 */
export const CODEX_SYNC_ALLOWLIST = [
  ...COPIED_SHARED_FILES,
  ...SYMLINKED_SHARED_FILES,
  "skills",
] as const;

export type ManagedCodexMcpGateway = {
  name: string;
  endpointPath: string;
  bearerToken: string;
};

export function mergeManagedCodexMcpGateways(
  primary: ManagedCodexMcpGateway[],
  secondary: ManagedCodexMcpGateway[],
): ManagedCodexMcpGateway[] {
  const merged = [...primary];
  const names = new Set(primary.map((gateway) => gateway.name));
  for (const gateway of secondary) {
    if (names.has(gateway.name)) continue;
    merged.push(gateway);
    names.add(gateway.name);
  }
  return merged;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

// Co-change notice: this function's logic is mirrored by parseAuth in
// packages/adapter-utils/src/sandbox-managed-runtime.ts (buildCodexAuthMergeDecisionScript).
// If the auth format changes (new shape, renamed field), update both sites together.
function hasUsableAuthPayload(authPayload: unknown): boolean {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return false;
  }

  const parsedPayload = authPayload as Record<string, unknown>;
  const apiKey = parsedPayload.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return true;
  }

  const tokens = parsedPayload.tokens;
  if (tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)) {
    const parsedTokens = tokens as Record<string, unknown>;
    const accountId = parsedTokens.account_id;
    const hasAccountId = typeof accountId === "string" && accountId.trim().length > 0;
    const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
      const value = parsedTokens[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (hasAccountId && hasTokenMaterial) return true;
  }

  return false;
}

function readApiKeyFromAuthPayload(authPayload: unknown): string | null {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return null;
  }
  const raw = (authPayload as Record<string, unknown>).OPENAI_API_KEY;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "codex-home")
    : path.resolve(instanceRoot, "codex-home");
}

/** Service-selected home for an agent when the local secrets key is isolated. */
export function resolveIsolatedCodexAgentHomeDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "agents", agentId, "codex-home");
}

/**
 * True when `homePath` lives under the Paperclip-managed company tree
 * (`<instanceRoot>/companies/<companyId>/...`). This covers both the shared
 * company `codex-home` and the per-agent `agents/<agentId>/codex-home` set by
 * the server-side isolation guard. A path outside that tree is a genuine
 * external/user-supplied override that Paperclip must not seed or overwrite.
 */
export function isManagedCodexHomePath(
  env: NodeJS.ProcessEnv,
  companyId: string | undefined,
  homePath: string,
): boolean {
  if (!companyId) return false;
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const companyRoot = path.resolve(instanceRoot, "companies", companyId);
  const resolved = path.resolve(homePath);
  return resolved === companyRoot || resolved.startsWith(companyRoot + path.sep);
}

/**
 * True when the Codex home has a usable `auth.json`. Uses `fs.access` (follows
 * symlinks), so a dangling auth symlink whose source has been removed counts as
 * no usable credentials.
 */
export async function codexHomeHasUsableAuth(home: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  if (!(await pathExists(authPath))) return false;
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return hasUsableAuthPayload(parsed);
  } catch {
    return false;
  }
}

async function codexHomeHasMatchingApiKeyAuth(home: string, apiKey: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  const existing = await fs.lstat(authPath).catch(() => null);
  if (!existing || existing.isSymbolicLink()) return false;
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return readApiKeyFromAuthPayload(parsed) === apiKey.trim();
  } catch {
    return false;
  }
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return false;

  return path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

async function createExpectedSymlink(target: string, source: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && await isExpectedSymlink(target, source)) return;
    throw error;
  }
}

export async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (!existing.isSymbolicLink()) {
    // A previous Paperclip version copied this file into the managed home
    // instead of symlinking it. Codex refresh tokens rotate and are
    // single-use, so a stale copy fails with refresh_token_reused on the next
    // run (#5028). Replace the regular file with a symlink so the CLI follows
    // the live source. Safe to delete: target is always under the
    // Paperclip-managed company home, never the user's real ~/.codex.
    // Directories are left alone — `fs.unlink` would throw EISDIR on Unix
    // (and behave inconsistently on Windows). A directory at this path is not
    // a Paperclip-written stale copy and warrants operator inspection rather
    // than silent removal.
    if (existing.isDirectory()) return;
    await fs.unlink(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (await isExpectedSymlink(target, source)) return;

  await fs.unlink(target);
  await createExpectedSymlink(target, source);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isFile()) return;
  if (existing && !existing.isSymbolicLink()) {
    throw new Error("Managed Codex home copy target is not a regular file");
  }
  const bytes = await readRegularFileNoFollow(source);
  if (!bytes) throw new Error("Managed Codex home copy source is missing or linked");
  await ensureParentDir(target);
  await replaceRegularFileNoFollow(target, bytes);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeMcpServerName(value: string, fallback: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function stripManagedMcpBlock(config: string): string {
  const start = config.indexOf(MANAGED_MCP_BLOCK_START);
  if (start < 0) return config.trimEnd();
  const end = config.indexOf(MANAGED_MCP_BLOCK_END, start);
  if (end < 0) return config.slice(0, start).trimEnd();
  return `${config.slice(0, start)}${config.slice(end + MANAGED_MCP_BLOCK_END.length)}`.trimEnd();
}

function readCodexMcpServerNames(config: string): Set<string> {
  const names = new Set<string>();
  for (const match of config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^\]\s#]+))\s*\]/gm)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name.trim());
  }
  return names;
}

function buildManagedMcpBlock(input: {
  gateways: ManagedCodexMcpGateway[];
  apiBaseUrl: string;
  existingNames: Set<string>;
}): { block: string; warnings: string[] } {
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const lines = [
    MANAGED_MCP_BLOCK_START,
    "# Written by Paperclip for governed MCP gateway access. Do not edit this block by hand.",
  ];
  input.gateways.forEach((gateway, index) => {
    const baseName = sanitizeMcpServerName(gateway.name, `gateway-${index + 1}`);
    const directOverlap = input.existingNames.has(gateway.name) || input.existingNames.has(baseName);
    let managedName = directOverlap ? `paperclip-${baseName}` : baseName;
    let suffix = 2;
    while (usedNames.has(managedName) || input.existingNames.has(managedName)) {
      managedName = `paperclip-${baseName}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(managedName);
    if (directOverlap) {
      warnings.push(
        `Found unmanaged Codex MCP server "${gateway.name}" overlapping a Paperclip-governed gateway; leaving the direct entry in place and adding managed gateway "${managedName}". Paperclip cannot enforce policies for that direct entry.`,
      );
    }
    const url = new URL(gateway.endpointPath, input.apiBaseUrl).toString();
    lines.push(
      "",
      `[mcp_servers.${tomlString(managedName)}]`,
      `url = ${tomlString(url)}`,
      `headers = { Authorization = ${tomlString(`Bearer ${gateway.bearerToken}`)} }`,
    );
  });
  lines.push(MANAGED_MCP_BLOCK_END);
  return { block: lines.join("\n"), warnings };
}

export async function writeManagedCodexMcpConfig(input: {
  codexHome: string;
  apiBaseUrl: string;
  gateways: ManagedCodexMcpGateway[];
}): Promise<{ configPath: string; warnings: string[] }> {
  const configPath = path.join(input.codexHome, "config.toml");
  await fs.mkdir(input.codexHome, { recursive: true });
  const existing = (await readRegularFileNoFollow(configPath))?.toString("utf8") ?? "";
  const unmanagedConfig = stripManagedMcpBlock(existing);
  const { block, warnings } = buildManagedMcpBlock({
    gateways: input.gateways,
    apiBaseUrl: input.apiBaseUrl,
    existingNames: readCodexMcpServerNames(unmanagedConfig),
  });
  const next = input.gateways.length > 0
    ? `${unmanagedConfig}${unmanagedConfig ? "\n\n" : ""}${block}\n`
    : `${unmanagedConfig}${unmanagedConfig ? "\n" : ""}`;
  await replaceRegularFileNoFollow(configPath, next);
  return { configPath, warnings };
}

/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "auth.json");
  await replaceRegularFileNoFollow(target, JSON.stringify({ OPENAI_API_KEY: apiKey }));
}

export interface StageCodexHomeForSyncOptions {
  /** Run id, used only to make the staged temp-dir name traceable in logs. */
  runId?: string;
  /** Optional subset of the fixed allowlist; probes only need auth and config. */
  entries?: readonly (typeof CODEX_SYNC_ALLOWLIST)[number][];
  /** Exact trusted chain for a managed auth.json symlink, ending at a regular file. */
  authSourcePaths?: readonly string[];
  /** Selected, server-resolved skill sources. Unlisted home entries are never staged. */
  skillSources?: readonly { name: string; source: string }[];
  /** All server-selected runtime names and roots, including unselected skills. */
  trustedSkillSources?: readonly { name: string; source: string }[];
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSkillName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") ||
      name.includes("\\") || name.includes("\0") || path.basename(name) !== name) {
    throw new Error("Invalid selected Codex skill name");
  }
}

/** Reject dangerous home entries before provider config or skill injection reads the home. */
export async function assertIsolatedCodexHomeEntries(home: string): Promise<void> {
  const sourceHome = await openDirectoryNoFollow(home).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!sourceHome) return;
  try {
    for (const entry of CODEX_SYNC_ALLOWLIST) {
      const stat = await lstatChild(sourceHome, entry);
      if (!stat) continue;
      if (entry === "auth.json" && stat.isSymbolicLink()) {
        const linked = await readChildLink(sourceHome, entry);
        const expected = path.join(resolveSharedCodexHomeDir(process.env), "auth.json");
        if (!linked || path.resolve(home, linked) !== path.resolve(expected)) {
          throw new Error("Isolated Codex home contains an untrusted symlink.");
        }
        const source = await openPathNoFollow(expected);
        if (!source) throw new Error("Isolated Codex auth source must be a regular file.");
        try {
          if (!(await source.stat()).isFile()) throw new Error("Isolated Codex auth source must be a regular file.");
        } finally {
          await source.close();
        }
        continue;
      }
      if (stat.isSymbolicLink()) throw new Error("Isolated Codex home contains an untrusted symlink.");
      if (entry === "skills" ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error("Isolated Codex home contains an invalid entry type.");
      }
    }
  } finally {
    await sourceHome.close();
  }
}

/** Copy bytes from an already-open inode. An agent replacing its path cannot
 * redirect the service read after this point. */
async function stagePinnedEntry(source: SafeHandle, target: string, preserveExecutable = false, isolated = false): Promise<void> {
  const stat = await source.stat();
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await listPinnedDirectory(source)) {
      if (isolated && (await lstatChild(source, name))?.isSymbolicLink()) {
        throw new Error("Isolated Codex skill source contains a symlink.");
      }
      const child = await openChildNoFollow(source, name);
      if (!child) {
        if (isolated) throw new Error("Isolated Codex skill source changed during staging.");
        continue; // Never follow nested links, including directory aliases.
      }
      try {
        await stagePinnedEntry(child, path.join(target, name), preserveExecutable, isolated);
      } finally {
        await child.close();
      }
    }
  } else if (stat.isFile()) {
    const mode = preserveExecutable && (stat.mode & 0o111) !== 0 ? 0o700 : 0o600;
    await fs.writeFile(target, await source.readFile(), { mode });
    await fs.chmod(target, mode);
  } else if (isolated) {
    throw new Error("Isolated Codex skill source contains an invalid entry type.");
  }
  // In normal mode sockets, devices and nonblocking FIFOs are not staging inputs.
}

async function readBoundAuthSource(sources: readonly string[], index = 0): Promise<Buffer | null> {
  const source = sources[index];
  if (!source) throw new Error("Unbound Codex auth symlink");
  const dir = await openDirectoryNoFollow(path.dirname(source)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!dir) return null;
  try {
    const name = path.basename(source);
    const stat = await lstatChild(dir, name);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      const next = sources[index + 1];
      const linked = await readChildLink(dir, name);
      if (!next || !linked || path.resolve(path.dirname(source), linked) !== path.resolve(next)) {
        throw new Error("Codex auth symlink escaped its expected source");
      }
      return readBoundAuthSource(sources, index + 1);
    }
    if (!stat.isFile()) throw new Error("Codex auth source is not a regular file");
    const handle = await openChildNoFollow(dir, name);
    if (!handle) throw new Error("Codex auth source changed during staging");
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Codex auth source changed type");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } finally {
    await dir.close();
  }
}

async function stageCodexHomeEntry(
  sourceHome: SafeHandle,
  sourceHomePath: string,
  stagedHome: string,
  entry: (typeof CODEX_SYNC_ALLOWLIST)[number],
  options: StageCodexHomeForSyncOptions,
): Promise<void> {
  const stat = await lstatChild(sourceHome, entry);
  if (!stat) {
    if (entry === "skills" &&
        process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME === "true" &&
        (options.skillSources?.length ?? 0) > 0) {
      throw new Error("Selected Codex skills directory is missing in isolated mode.");
    }
    return;
  }
  const target = path.join(stagedHome, entry);

  if (entry === "skills") {
    if (!stat.isDirectory()) throw new Error("Codex skills entry is not a directory");
    const skills = await openChildNoFollow(sourceHome, entry);
    if (!skills) throw new Error("Codex skills directory changed during staging");
    try {
      if (!(await skills.stat()).isDirectory()) throw new Error("Codex skills entry changed type");
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      const isolated = process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME === "true";
      const trusted = new Map<string, string>();
      for (const skill of options.trustedSkillSources ?? []) {
        assertSkillName(skill.name);
        if (trusted.has(skill.name)) throw new Error("Duplicate trusted Codex skill name");
        trusted.set(skill.name, path.resolve(skill.source));
      }
      if (isolated) {
        // Validate every existing external link, including skills not selected for this run.
        // The link is never followed for staging; selected roots are opened by descriptor.
        for (const name of await listPinnedDirectory(skills)) {
          const stat = await lstatChild(skills, name);
          if (!stat?.isSymbolicLink()) continue;
          const linked = await readChildLink(skills, name);
          if (!linked || path.resolve(sourceHomePath, "skills", linked) !== trusted.get(name)) {
            throw new Error("Isolated Codex home contains an untrusted skill source.");
          }
        }
      }
      if (options.skillSources) {
        const seen = new Set<string>();
        for (const skill of options.skillSources) {
          assertSkillName(skill.name);
          if (seen.has(skill.name)) {
            throw new Error("Invalid selected Codex skill name");
          }
          seen.add(skill.name);
          if (isolated && trusted.get(skill.name) !== path.resolve(skill.source)) {
            throw new Error("Selected Codex skill source is not trusted.");
          }
          const source = await openPathNoFollow(skill.source);
          if (!source) throw new Error("Selected Codex skill source is missing or linked");
          try {
            await stagePinnedEntry(source, path.join(target, skill.name), true, isolated);
          } finally {
            await source.close();
          }
        }
      } else {
        if (isolated) {
          throw new Error("Isolated Codex staging requires an explicit selected skill subset.");
        }
        // Standalone staging callers can carry regular files/dirs; links are
        // always skipped. Production callers provide the exact selected set.
        for (const name of await listPinnedDirectory(skills)) {
          const source = await openChildNoFollow(skills, name);
          if (!source) continue;
          try {
            await stagePinnedEntry(source, path.join(target, name), true);
          } finally {
            await source.close();
          }
        }
      }
    } finally {
      await skills.close();
    }
    return;
  }

  if (entry === "auth.json" && stat.isSymbolicLink()) {
    const expected = options.authSourcePaths?.[0];
    const linked = await readChildLink(sourceHome, entry);
    if (!expected || !linked || path.resolve(sourceHomePath, linked) !== path.resolve(expected)) {
      throw new Error("Codex auth symlink escaped its expected source");
    }
    const bytes = await readBoundAuthSource(options.authSourcePaths ?? []);
    if (bytes) {
      await fs.writeFile(target, bytes, { mode: 0o600 });
      await fs.chmod(target, 0o600);
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Codex home allowlist entry is not a regular file");
  const source = await openChildNoFollow(sourceHome, entry);
  if (!source) throw new Error("Codex home entry changed during staging");
  try {
    if (!(await source.stat()).isFile()) throw new Error("Codex home entry changed type");
    await stagePinnedEntry(source, target);
  } finally {
    await source.close();
  }
}

/**
 * Stages {@link CODEX_SYNC_ALLOWLIST} (or a selected subset) from `effectiveCodexHome` into a
 * fresh private temp dir and returns its path, for registration as the sandbox
 * `home` asset. This replaces syncing the whole managed home + a name denylist:
 * only the files Codex actually needs are uploaded, so oversized runtime state
 * (`sessions/`, `*.sqlite`, `plugins/`, …) never reaches the sandbox.
 *
 * - **Only bound symlinks are read** — managed `auth.json` is read from its
 *   expected source chain and selected skills from server-resolved sources.
 *   Agent-controlled links and directory aliases are never followed.
 * - **Missing-but-optional entries are skipped** — no `auth.json` in
 *   keyring-credential mode, or no `config.json`, is not an error.
 * - **`mkdtemp` guarantees the staged dir is `0700`** on POSIX. Credential and
 *   config files are `0600`; selected skill executables retain only owner
 *   execute permission (`0700`). Nothing staged is group/other-readable.
 * - **Fail-closed** — any *unexpected* I/O error removes the partial temp dir
 *   and re-throws, so a run never proceeds with a partial or empty home.
 *
 * The caller owns removing the returned dir on run teardown.
 */
export async function stageCodexHomeForSync(
  effectiveCodexHome: string,
  options: StageCodexHomeForSyncOptions = {},
): Promise<string> {
  const isolated = process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME === "true";
  if (isolated) {
    await assertIsolatedCodexHomeEntries(effectiveCodexHome);
  }
  const trustedSkillRoots = (options.trustedSkillSources ?? []).map((entry) => path.resolve(entry.source));
  if (isolated) {
    for (const [envName, label] of [
      ["PAPERCLIP_SECRETS_MASTER_KEY_FILE", "local secrets key"],
      ["PAPERCLIP_DATABASE_URL_FILE", "database credential"],
    ] as const) {
      const secretPath = nonEmpty(process.env[envName]);
      if (!secretPath) continue;
      const candidates = [path.resolve(secretPath)];
      const resolved = await fs.realpath(secretPath).catch(() => null);
      if (resolved) candidates.push(resolved);
      if (trustedSkillRoots.some((root) => candidates.some((candidate) => isPathInside(candidate, root)))) {
        throw new Error(`Isolated Codex skill source overlaps the ${label}.`);
      }
    }
  }
  const runIdPart = nonEmpty(options.runId ?? undefined);
  const stagedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), `paperclip-codex-home-sync-${runIdPart ? `${runIdPart}-` : ""}`),
  );
  try {
    const sourceHome = await openDirectoryNoFollow(effectiveCodexHome);
    try {
      for (const entry of options.entries ?? CODEX_SYNC_ALLOWLIST) {
        if (!(CODEX_SYNC_ALLOWLIST as readonly string[]).includes(entry)) {
          throw new Error("Codex home staging entry is not allowlisted");
        }
        await stageCodexHomeEntry(sourceHome, effectiveCodexHome, stagedHome, entry, options);
      }
    } finally {
      await sourceHome.close();
    }
    return stagedHome;
  } catch (error) {
    // Fail-closed: never hand back a partial home. Remove the temp dir we
    // created before propagating the failure.
    await fs.rm(stagedHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Seeds auth/config into an explicit Paperclip-managed `targetHome`. Symlinks
 * `auth.json` from the shared source home (so ChatGPT-subscription credentials
 * stay live and single-use refresh tokens are not copied), copies the static
 * shared config files, and — when an API key is supplied — writes an API-key
 * `auth.json` instead. Used both for the default company home and for the
 * per-agent home set by the server isolation guard.
 */
export async function seedManagedCodexHome(
  targetHome: string,
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  options: { apiKey?: string | null } = {},
): Promise<void> {
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  await fs.mkdir(targetHome, { recursive: true });

  // If a previous run wrote an apikey-mode auth.json (regular file) and this
  // run has no apiKey, remove it so the chatgpt-mode symlink can be restored.
  // Without this cleanup, ensureSymlink bails on a non-symlink and Codex keeps
  // authenticating with the stale key after it is removed from configuration.
  if (!apiKey && seedFromShared) {
    const authPath = path.join(targetHome, "auth.json");
    const existing = await fs.lstat(authPath).catch(() => null);
    if (existing && !existing.isSymbolicLink()) {
      await fs.rm(authPath, { force: true });
    }
  }

  if (seedFromShared) {
    for (const name of SYMLINKED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureSymlink(path.join(targetHome, name), source);
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
    );
  }

  if (apiKey) {
    await writeApiKeyAuthJson(targetHome, apiKey);
    await onLog(
      "stdout",
      `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
    );
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null } = {},
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);
  await seedManagedCodexHome(targetHome, env, onLog, options);
  return targetHome;
}

export type ReconcileManagedCodexHomeStatus =
  | "no_managed_home"
  | "external_override"
  | "already_seeded"
  | "source_auth_missing"
  | "seeded";

export interface ReconcileManagedCodexHomeInput {
  companyId: string | undefined;
  configuredCodexHome: string | null | undefined;
  apiKey?: string | null;
  /**
   * Set when the agent's persisted `OPENAI_API_KEY` is a secret binding that
   * could not be resolved in this context (e.g. startup reconciliation, which
   * never resolves secrets). When true and the home already has usable auth,
   * reconciliation preserves that auth instead of downgrading it to the shared
   * subscription symlink.
   */
  apiKeySecretBound?: boolean;
  env?: NodeJS.ProcessEnv;
  onLog?: AdapterExecutionContext["onLog"];
}

export interface ReconcileManagedCodexHomeResult {
  status: ReconcileManagedCodexHomeStatus;
  home: string | null;
}

const noopOnLog: AdapterExecutionContext["onLog"] = async () => {};

/**
 * Idempotently reconciles a persisted `codex_local` agent home. Phase 1 seeds
 * managed homes at execute time; this is the backfill for agents that already
 * carry a persisted (but unseeded) per-agent `CODEX_HOME` and have not run
 * since the seeding fix landed. Shares the managed-home detection
 * (`isManagedCodexHomePath`) and seeding (`seedManagedCodexHome`) logic so a
 * genuine external/user override is never touched. Safe to re-run: when a valid
 * `auth.json` is already present (and no API-key rewrite is requested) it is a
 * no-op and reports `already_seeded`.
 */
export async function reconcileManagedCodexHome(
  input: ReconcileManagedCodexHomeInput,
): Promise<ReconcileManagedCodexHomeResult> {
  const env = input.env ?? process.env;
  const configured = nonEmpty(input.configuredCodexHome ?? undefined);
  if (!configured) return { status: "no_managed_home", home: null };

  const resolved = path.resolve(configured);
  if (!isManagedCodexHomePath(env, input.companyId, resolved)) {
    return { status: "external_override", home: resolved };
  }

  const apiKey = nonEmpty(input.apiKey ?? undefined);
  const hadUsableAuth = await codexHomeHasUsableAuth(resolved);

  // A secret-bound OPENAI_API_KEY cannot be resolved here, so we cannot rewrite
  // it into auth.json. If the home already has usable auth — typically an
  // API-key auth.json written at execute time when the secret WAS resolved —
  // preserve it. Re-seeding without the key would delete that file and restore
  // the shared subscription symlink, silently changing the agent's credentials
  // on every boot while the persisted config still says "use the secret key".
  if (input.apiKeySecretBound && hadUsableAuth) {
    return { status: "already_seeded", home: resolved };
  }

  if (apiKey && await codexHomeHasMatchingApiKeyAuth(resolved, apiKey)) {
    return { status: "already_seeded", home: resolved };
  }

  await seedManagedCodexHome(resolved, env, input.onLog ?? noopOnLog, { apiKey });

  if (!apiKey && !(await codexHomeHasUsableAuth(resolved))) {
    return { status: "source_auth_missing", home: resolved };
  }

  // Without an API key, seeding only changes disk state when auth was missing.
  // With an API key, the matching-file short-circuit above filters out the
  // already-seeded case before this write path.
  const status: ReconcileManagedCodexHomeStatus =
    !apiKey && hadUsableAuth ? "already_seeded" : "seeded";
  return { status, home: resolved };
}

export type CodexCredentialAuthMode = "api" | "subscription";

export interface CodexCredentialReadinessInput {
  env?: NodeJS.ProcessEnv;
  companyId: string | undefined;
  /** `config.env.CODEX_HOME` for the run, if any. */
  configuredCodexHome: string | null | undefined;
  /** Resolved `config.env.OPENAI_API_KEY` value (after secret resolution). */
  configuredApiKey: string | null | undefined;
}

export interface CodexCredentialReadiness {
  /** True when Paperclip owns the effective home and is responsible for its auth. */
  managed: boolean;
  authMode: CodexCredentialAuthMode;
  /** True when a run launched now would be able to authenticate. */
  ready: boolean;
  effectiveHome: string;
  /** The shared source home subscription auth is symlinked from (managed homes only). */
  sharedSourceHome: string;
}

/**
 * Read-only predictor for whether a `codex_local` run will be able to
 * authenticate, without seeding or mutating any home. Mirrors the execute-time
 * fail-fast in `execute.ts`, factored out so the control plane can run the same
 * check *before* dispatch and surface a configuration-incomplete blocker instead
 * of dispatching a run that is guaranteed to fail with "no Codex credentials".
 *
 * - An external/user-supplied `CODEX_HOME` override manages its own auth, so it
 *   is always treated as ready (Paperclip must not seed or inspect it).
 * - A non-empty resolved `OPENAI_API_KEY` means API-key auth, always ready.
 * - Otherwise (subscription mode) the run needs a usable `auth.json`. Because a
 *   managed home symlinks `auth.json` from the shared source home at seed time,
 *   we treat the run as ready when either the (possibly already-seeded) effective
 *   home or the shared source home carries usable auth.
 */
export async function evaluateCodexCredentialReadiness(
  input: CodexCredentialReadinessInput,
): Promise<CodexCredentialReadiness> {
  const env = input.env ?? process.env;
  const configuredRaw = nonEmpty(input.configuredCodexHome ?? undefined);
  const configuredCodexHome = configuredRaw ? path.resolve(configuredRaw) : null;
  const configuredApiKey = nonEmpty(input.configuredApiKey ?? undefined);
  const sharedSourceHome = resolveSharedCodexHomeDir(env);

  const configuredHomeIsManaged =
    configuredCodexHome != null && isManagedCodexHomePath(env, input.companyId, configuredCodexHome);
  const effectiveHomeIsManaged = configuredCodexHome == null || configuredHomeIsManaged;
  const effectiveHome = configuredCodexHome ?? resolveManagedCodexHomeDir(env, input.companyId);

  if (!effectiveHomeIsManaged) {
    // Genuine external override: Paperclip never seeds or inspects it.
    return {
      managed: false,
      authMode: configuredApiKey ? "api" : "subscription",
      ready: true,
      effectiveHome,
      sharedSourceHome,
    };
  }

  if (configuredApiKey) {
    return { managed: true, authMode: "api", ready: true, effectiveHome, sharedSourceHome };
  }

  const ready =
    (await codexHomeHasUsableAuth(effectiveHome)) ||
    (await codexHomeHasUsableAuth(sharedSourceHome));
  return { managed: true, authMode: "subscription", ready, effectiveHome, sharedSourceHome };
}
